/**
 * note完結版バックエンド (Cloudflare Workers想定)
 *
 * 決済確認は自動化しない。運営がnoteの購入を手動で確認したあとに
 * 管理エンドポイントで「受付番号」を発行する。Web側はその番号を
 * 消費できた場合にのみClaude APIを呼び出す。
 * -> 「入金確認(手動) -> 利用権発行 -> その後API使用」の順序を機械的に保証する。
 *
 * 環境変数 / バインディング:
 *   ADMIN_SECRET        - 受付番号発行エンドポイントを叩くための合言葉(運営のみが知る)
 *   ANTHROPIC_API_KEY    - Claude APIキー
 *   CODES                - KV Namespace (受付番号の状態を保存)
 */

const MAX_OUTPUT_TOKENS = 900;
const MAX_INPUT_CHARS = 1500;
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const routes = {
      "/api/admin/issue-code": handleIssueCode,
      "/api/redeem": handleRedeem,
      "/api/analyze": handleAnalyze,
      "/api/analyze-entry": handleAnalyzeEntry,
      "/api/line/webhook": handleLineWebhook
    };
    const handler = request.method === "POST" ? routes[url.pathname] : null;
    if (!handler) return new Response("Not found", { status: 404 });
    return handler(request, env);
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
function generateCode() {
  let code = "";
  for (let i = 0; i < 4; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return code;
}
async function handleIssueCode(request, env) {
  let body; try { body = await request.json(); } catch (e) { return json({ error: "invalid_request" }, 400); }
  if (body.secret !== env.ADMIN_SECRET) return json({ error: "unauthorized" }, 401);
  if (!["1980", "9800"].includes(body.tier)) return json({ error: "invalid_tier" }, 400);
  let code;
  for (let attempt = 0; attempt < 5; attempt++) { code = generateCode(); if (!(await env.CODES.get(`code:${code}`))) break; }
  const record = { tier: body.tier, used: false, lineRemaining: body.tier === "9800" ? 10 : 0, note: body.note || "" };
  await env.CODES.put(`code:${code}`, JSON.stringify(record), { expirationTtl: 60 * 60 * 24 * 30 });
  return json({ code, tier: body.tier });
}
async function handleRedeem(request, env) {
  let body; try { body = await request.json(); } catch (e) { return json({ error: "invalid_request" }, 400); }
  const code = String(body.code || "").toUpperCase().trim();
  if (!code) return json({ error: "missing_code" }, 400);
  const raw = await env.CODES.get(`code:${code}`); if (!raw) return json({ error: "invalid_code" }, 404);
  const record = JSON.parse(raw);
  if (record.tier === "1980" && record.used) return json({ error: "code_already_used" }, 409);
  if (record.tier === "9800" && record.used && record.lineRemaining <= 0) return json({ error: "code_exhausted" }, 409);
  const token = crypto.randomUUID();
  await env.CODES.put(`token:${token}`, JSON.stringify({ code, tier: record.tier }), { expirationTtl: 60 * 60 * 6 });
  return json({ token, tier: record.tier, lineRemaining: record.lineRemaining });
}
async function handleAnalyze(request, env) {
  let body; try { body = await request.json(); } catch (e) { return json({ error: "invalid_request" }, 400); }
  const { token, formData } = body; if (!token || !formData) return json({ error: "missing_fields" }, 400);
  const rawToken = await env.CODES.get(`token:${token}`); if (!rawToken) return json({ error: "invalid_or_expired_token" }, 403);
  const { code, tier } = JSON.parse(rawToken);
  const rawCode = await env.CODES.get(`code:${code}`); if (!rawCode) return json({ error: "code_not_found" }, 403);
  const record = JSON.parse(rawCode);
  if (tier === "1980" && record.used) return json({ error: "already_used" }, 409);
  if (tier === "9800" && record.used && record.lineRemaining <= 0) return json({ error: "code_exhausted" }, 409);
  record.used = true;
  if (tier === "9800" && body.consumeLine) record.lineRemaining = Math.max(0, record.lineRemaining - 1);
  await env.CODES.put(`code:${code}`, JSON.stringify(record)); await env.CODES.delete(`token:${token}`);
  const freeText = String(formData.freeText || "").slice(0, MAX_INPUT_CHARS);
  const claudeRes = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: MAX_OUTPUT_TOKENS, system: buildSystemPrompt(resolveRoute(formData)), messages: [{ role: "user", content: buildUserPrompt(formData, freeText) }] }) });
  if (!claudeRes.ok) return json({ error: "analysis_failed" }, 502);
  const data = await claudeRes.json(); const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
  return json({ result: text, lineRemaining: record.lineRemaining });
}
const ENTRY_MAX_OUTPUT_TOKENS = 700;
const ENTRY_MAX_FREE_TEXT_CHARS = 600;
const ENTRY_RATE_LIMIT_PER_HOUR = 3;
async function handleAnalyzeEntry(request, env) {
  let body; try { body = await request.json(); } catch (e) { return json({ error: "invalid_request" }, 400); }
  const formData = body.formData; if (!formData) return json({ error: "missing_fields" }, 400);
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const rateKey = `entryrate:${ip}:${new Date().toISOString().slice(0, 13)}`;
  const countRaw = await env.CODES.get(rateKey); const count = countRaw ? parseInt(countRaw, 10) : 0;
  if (count >= ENTRY_RATE_LIMIT_PER_HOUR) return json({ error: "rate_limited" }, 429);
  await env.CODES.put(rateKey, String(count + 1), { expirationTtl: 60 * 60 });
  const freeText = String(formData.freeText || "").slice(0, ENTRY_MAX_FREE_TEXT_CHARS);
  const claudeRes = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: ENTRY_MAX_OUTPUT_TOKENS, system: buildEntrySystemPrompt(resolveRoute(formData)), messages: [{ role: "user", content: buildEntryUserPrompt(formData, freeText) }] }) });
  if (!claudeRes.ok) return json({ error: "analysis_failed" }, 502);
  const data = await claudeRes.json(); const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
  return json({ result: text });
}
function buildEntrySystemPrompt(route) {
  return `あなたは恋愛relationshipの状況整理をサポートするアシスタントです。\nこれは入口商品(780円)向けの分析であり、簡潔に要点を伝えることを優先してください。\n\n以下のルールを厳守してください。\n\n1. 相手本人の内心(恋愛感情・性的指向・結婚への意思など)を、入力された事実だけから断定してはいけません。\n   「〇〇の可能性がある」「まだ判断できない」という表現に留めてください。\n2. 「相手が同性愛に理解がある」「相手自身が同性を恋愛対象にする」「相談者本人が相手の恋愛対象である」\n   は全く別の事柄です。これらを混同したり、根拠なく一つから他を推測してはいけません。\n${maritalClause(route)}\n4. 出力は必ず次の5つの見出しで構成してください。それぞれ2〜4文程度、簡潔にまとめること。\n   ① 現在地\n   ② そう考えられる理由\n   ③ まだ分からないこと\n   ④ 今やらない方がいいこと\n   ⑤ 次にできること\n5. 誠実でおだやかなトーンとし、断定・煽り・過度な期待を持たせる表現は避けてください。\n6. 「もっと詳しく知りたい場合は」のような次商品への言及は行わないでください。案内は別画面で行います。`;
}
function buildEntryUserPrompt(f, freeText) { return `以下は780円商品の購入者が入力した状況です。この情報だけをもとに、5つの見出しで簡潔に整理してください。\n\n【本人】年代:${f.selfAge} 性別:${f.selfGender} 属性:${f.selfOccupation} 婚姻:${f.selfMarital} 交際:${f.selfHasPartner} 恋愛対象:${f.selfOrientationTarget}\n【相手】年代:${f.otherAge} 性別:${f.otherGender} 属性:${f.otherOccupation} 婚姻:${f.otherMarital} 交際:${f.otherHasPartner}\n【関係】種別:${f.relationType} 段階:${f.stage} 期間:${f.knownPeriod} 二人で会った回数:${f.aloneCount}\n【連絡】本人から:${f.contactFreqSelf} 相手から:${f.contactFreqOther}\n\n【自由記述】\n${freeText || "(記入なし)"}\n`; }
async function handleLineWebhook(request, env) { return json({ status: "not_configured" }, 501); }
function buildSystemPrompt(route) { return `あなたは恋愛relationshipの状況整理をサポートするアシスタントです。\n以下のルールを厳守してください。\n\n1. 相手本人の内心(恋愛感情・性的指向・結婚への意思など)を、入力された事実だけから断定してはいけません。\n   「〇〇の可能性がある」「まだ判断できない」という表現に留めてください。\n2. 「相手が同性愛に理解がある」「相手自身が同性を恋愛対象にする」「相談者本人が相手の恋愛対象である」\n   は全く別の事柄です。これらを混同したり、根拠なく一つから他を推測してはいけません。\n${maritalClause(route)}\n4. 出力は次の構成に従ってください:\n   1) 現在地  2) そう判断した理由(事実ベース)  3) まだ判断できないこと\n   4) 今やらない方がいいこと  5) 次にやること(具体的に)  6) 会話・メッセージの言い方の例\n5. 誠実でおだやかなトーンとし、断定・煽り・過度な期待を持たせる表現は避けてください。`; }
function resolveRoute(f) { if (f.stage === "marriedCouple") return "couple"; if (f.selfMarital === "married" || f.otherMarital === "married") return "marriedInvolved"; return "other"; }
function maritalClause(route) {
  if (route === "couple") return `3. 本人たちは夫婦です。今回の相談は通常の夫婦関係の相談として扱ってください。すれ違い・会話不足・距離感の変化などについて、関係を修復するための具体的な会話の工夫や行動を助言してください。「不倫」を前提にした注意や制限は不要です。\n   自由記述に「寂しい」「距離を感じる」「話せなくなった」のような感情の言葉が書かれていた場合は、そのうち1つを拾って現在地の説明に反映してください(例:「関係が終わっているわけではない。でも、夫婦なのに少し遠く感じる。そんな状態に見えます。」)。ただし過度に共感しすぎず、感情に寄り添いすぎた言い回しは避けてください。\n   「〜が大切です」「〜を尊重することが助けになります」のような教科書的・カウンセリング的な定型文は避け、LINEで知人に相談したときのような、短く自然な日本語で書いてください。`;
  if (route === "marriedInvolved") return `3. 本人または相手に、今回の関係の相手とは別の配偶者がいます。不倫関係の成就を支援する助言(「バレない方法」「離婚させる方法」等)\n   は一切行わないでください。関係の整理・現状把握のための助言に限定してください。`;
  return `3. 今回の相談に婚姻関係は関与していません。`;
}
function buildUserPrompt(f, freeText) { return `以下は780円の入口分析を経たユーザーの詳細情報です。この情報をもとに個別分析を行ってください。\n\n【本人】年代:${f.selfAge} 性別:${f.selfGender} 属性:${f.selfOccupation} 婚姻:${f.selfMarital} 交際:${f.selfHasPartner} 恋愛対象:${f.selfOrientationTarget}\n【相手】年代:${f.otherAge} 性別:${f.otherGender} 属性:${f.otherOccupation} 婚姻:${f.otherMarital} 交際:${f.otherHasPartner}\n【関係】種別:${f.relationType} 段階:${f.stage} 期間:${f.knownPeriod} 二人で会った回数:${f.aloneCount}\n【連絡】本人から:${f.contactFreqSelf} 相手から:${f.contactFreqOther}\n\n【自由記述(これまでの経緯・今知りたいこと)】\n${freeText}\n`; }
