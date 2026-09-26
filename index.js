import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { privateKeyToAccount } from "viem/accounts";
import axios from "axios";
import { solveChallenge, pbkdf2 } from "altcha/lib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ACCOUNTS_FILE        = "accounts.json";
const BYTECODE_FILE        = "bytecode.txt";
const GROQ_FILE            = "groq.txt";
const TXHASH_FILE          = "txhashes.json";
const FAUCET_COOLDOWN_FILE = "faucet_cooldowns.json";

const API_BASE        = "https://rewards.svpstars.com/api/v1";
const FAUCET_ENDPOINT = "https://www.svpchain.org/api/claim";
const ALTCHA_BASE     = "https://www.svpchain.org/api/altcha/challenge";
const GROQ_URL        = "https://api.groq.com/openai/v1/chat/completions";
const EXPLORER        = "https://explorer.svpchain.com/tx";

const CHAIN_ID           = 2517;
const RPC_URL            = process.env.RPC_URL || "https://svp-dataseed1-testnet.svpchain.org";
const MIN_GAS_PRICE      = ethers.parseUnits("2", "gwei");
const GAS_LIMIT_FALLBACK = 2_500_000n;

const GROQ_MODEL    = process.env.GROQ_MODEL    || "openai/gpt-oss-120b";
const GROQ_FALLBACK = process.env.GROQ_FALLBACK || "openai/gpt-oss-20b";
const INVITE_CODE   = process.env.INVITE_CODE   || "";

const LENDORA_MAX_SUPPLY = process.env.LENDORA_MAX_SUPPLY || "10";

const ROUTER_ADDRESS      = "0xfe7bf2dfd5cb268c6779f1f614638a436cb701e4";
const WSVP_ADDRESS        = "0x771a0a63d8198b7dbea4a16910ff68ab38006531";
const SWAP_SLIPPAGE_PCT   = BigInt(process.env.SLIPPAGE_PERCENT || "20");
const SWAP_AMOUNT_PER_LEG = ethers.parseEther(process.env.SWAP_SVP_PER_LEG || "0.008");
const SWAP_MIN_RESERVE    = ethers.parseEther("0.005");

const SWAP_LEGS = [
  { from: "WSVP", to: "USDC", amount: SWAP_AMOUNT_PER_LEG },
  { from: "WSVP", to: "WETH", amount: SWAP_AMOUNT_PER_LEG },
  { from: "WSVP", to: "WBTC", amount: SWAP_AMOUNT_PER_LEG },
];

const TOKENS = {
  WSVP: WSVP_ADDRESS,
  USDC: "0x732f6ea7afd5edc02e7ba052075dd0780e285489",
  USDV: "0x013a61e622e6abfcab64f52d274c3fc0aa37f951",
  WETH: "0x1c12dbda863900c680a3836c53d408feaf63f0ba",
  WBTC: "0x6c22ceb0852bd7781b57574aaa5de0f22cd44162",
  WBNB: "0x8787384b8640f6e9c30e94585d3d62b03f80a5df",
};

const CTOKENS = {
  USDC: { cToken: "0xC647A36ea112109E6B341399f665F10cEaEecEC3", underlying: "0x732F6Ea7AfD5EdC02e7ba052075dd0780e285489", decimals: 6  },
  WBTC: { cToken: "0x6653b238548927c15A5dd2046af15C88018BF1aa", underlying: "0x6C22ceB0852bd7781B57574aAA5De0F22cd44162", decimals: 8  },
  WBNB: { cToken: "0x668cC3523050cd8ef48e0fd1210F32013E630612", underlying: "0x8787384B8640f6E9c30E94585d3d62b03F80a5Df", decimals: 18 },
};

const BRIDGE_CONTRACT           = "0xC2C7f43735C4bEC84eABbcce32bDA269c2c75f20";
const BRIDGE_FUNCTION_SELECTOR  = "0x8d1a0e7d";
const BRIDGE_DEST_CHAIN_ID      = 421614;
const BRIDGE_DST_TOKEN          = "0x7a8ecfa70374c1b8702cb98aaf23de19675981d6";
const BRIDGE_AMOUNT_MIN         = ethers.parseEther(process.env.BRIDGE_MIN_SVP || "0.1");
const BRIDGE_AMOUNT_MAX         = ethers.parseEther(process.env.BRIDGE_MAX_SVP || "0.15");
const BRIDGE_MIN_NATIVE_RESERVE = ethers.parseEther("0.02");
const BRIDGE_VERIFY_WAIT_MS     = 90_000;

const FAUCET_TOKENS = [
  { symbol: "SVP",  address: "0x0000000000000000000000000000000000000000" },
  { symbol: "USDV", address: "0x013a61E622e6ABFCaB64F52D274C3Fc0aA37f951" },
  { symbol: "USDC", address: "0x732f6ea7afd5edc02e7ba052075dd0780e285489" },
  { symbol: "WBTC", address: "0x6c22ceb0852bd7781b57574aaa5de0f22cd44162" },
  { symbol: "WBNB", address: "0x8787384b8640f6e9c30e94585d3d62b03f80a5df" },
];

const INTER_TOKEN_DELAY       = 60_000;
const RETRY_WAIT_RATE_LIMIT   = 90_000;
const RETRY_WAIT_SERVER_ERR   = 15_000;
const RETRYABLE_STATUS        = new Set([429, 500, 502, 503, 504]);
const MAX_CLAIM_ATTEMPTS      = 3;
const MAX_ALTCHA_ATTEMPTS     = 3;
const ALTCHA_SOLVE_TIMEOUT_MS = 45_000;
const FAUCET_COOLDOWN_MS      = 24 * 60 * 60 * 1000;

const args    = process.argv.slice(2);
const getArg  = (name, fb = null) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fb; };
const hasFlag = (name) => args.includes(name);

const DRY_RUN     = hasFlag("--dry");
const SKIP_DEPLOY = hasFlag("--skip-deploy");
const DO_LEND     = !hasFlag("--no-lend");
const DO_BRIDGE   = !hasFlag("--no-bridge");
const DO_SWAP     = !hasFlag("--no-swap");
const RUN_ONCE    = hasFlag("--once");
const RESET_HOUR  = Number.parseInt(getArg("--reset-hour", "0"), 10);
const ONLY_ADDR   = (getArg("--only", "") || "").toLowerCase() || null;

const JITTER_MIN = 800;
const JITTER_MAX = 2500;
const COOLDOWN_BETWEEN_ACCOUNTS = 30_000;

const SKIP_ACTIONS = new Set([
  "bind_x", "x_follow", "tg_join", "discord_join", "tweet",
]);

const C = {
  reset: "\x1b[0m", red: "\x1b[31m", green: "\x1b[32m",
  yellow: "\x1b[33m", cyan: "\x1b[36m", magenta: "\x1b[35m",
  blue: "\x1b[34m", bold: "\x1b[1m", dim: "\x1b[2m",
};
const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const log   = (...a) => console.log(`[${stamp()}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = () => sleep(JITTER_MIN + Math.random() * (JITTER_MAX - JITTER_MIN));

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36 Edg/139.0.0.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
  "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 15; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 OPR/116.0.0.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36 Vivaldi/6.9",
];

const randUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

const baseHeaders = (extra = {}) => ({
  "accept": "*/*",
  "accept-language": "en-GB,en;q=0.9",
  "user-agent": randUA(),
  ...extra,
});

function readText(file) {
  const p = path.isAbsolute(file) ? file : path.join(__dirname, file);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, "utf8");
}

function loadJson(file, fallback) {
  const t = readText(file);
  if (t == null) return fallback;
  try { return JSON.parse(t); }
  catch (e) { throw new Error(`${file} is not valid JSON: ${e.message}`); }
}

function saveJson(file, data) {
  const p = path.isAbsolute(file) ? file : path.join(__dirname, file);
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
}

function loadGroqKey() {
  const t = readText(GROQ_FILE);
  if (!t) return "";
  const key = t.trim().split(/\s+/)[0];
  return key.startsWith("gsk_") ? key : "";
}

function loadAccounts() {
  const raw = loadJson(ACCOUNTS_FILE, null);
  if (!Array.isArray(raw) || raw.length === 0) throw new Error(`${ACCOUNTS_FILE} missing or empty.`);
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    const label = a.label || `#${i + 1}`;
    let pk = a.privateKey;
    if (!pk || typeof pk !== "string") continue;
    pk = pk.trim();
    if (!pk.startsWith("0x")) pk = "0x" + pk;
    if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) continue;
    const account = privateKeyToAccount(pk);
    if (a.address && a.address.toLowerCase() !== account.address.toLowerCase()) continue;
    if (ONLY_ADDR && account.address.toLowerCase() !== ONLY_ADDR) continue;
    out.push({ label, address: account.address, privateKey: pk });
  }
  return out;
}

function loadBytecode() {
  const t = readText(BYTECODE_FILE);
  if (!t) return null;
  let hex = t.trim().replace(/\s+/g, "");
  if (!hex) return null;
  if (!hex.startsWith("0x")) hex = "0x" + hex;
  if (!/^0x[0-9a-fA-F]+$/.test(hex)) throw new Error(`${BYTECODE_FILE} not valid hex`);
  if ((hex.length - 2) % 2 !== 0) throw new Error(`${BYTECODE_FILE} odd hex length`);
  if ((hex.length - 2) / 2 < 32) throw new Error(`${BYTECODE_FILE} too short`);
  return hex;
}

const TXHASHES = (() => {
  const data = loadJson(TXHASH_FILE, {}) || {};
  return {
    data,
    get: (w, k) => data[w.toLowerCase()]?.[k] ?? null,
    has: (w, k) => !!data[w.toLowerCase()]?.[k],
    set(w, k, v) {
      const key = w.toLowerCase();
      data[key] = data[key] || {};
      data[key][k] = v;
      saveJson(TXHASH_FILE, data);
    },
  };
})();

const FAUCET_COOLDOWNS = (() => {
  const data = loadJson(FAUCET_COOLDOWN_FILE, {}) || {};
  return {
    data,
    get: (wallet, token) => data[wallet.toLowerCase()]?.[token.toLowerCase()] ?? 0,
    set(wallet, token, ts) {
      const w = wallet.toLowerCase();
      const t = token.toLowerCase();
      data[w] = data[w] || {};
      data[w][t] = ts;
      saveJson(FAUCET_COOLDOWN_FILE, data);
    },
    isFresh(wallet, token) {
      return Date.now() - this.get(wallet, token) < FAUCET_COOLDOWN_MS;
    },
  };
})();

async function httpJson(method, url, { headers, body } = {}) {
  const res = await axios.request({
    method, url,
    headers: baseHeaders(headers),
    data: body,
    timeout: 30000,
    validateStatus: () => true,
  });
  return { status: res.status, data: res.data };
}

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)",
  "function decimals() view returns (uint8)",
];

const CTOKEN_ABI = [
  "function mint(uint256 mintAmount) returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];

const ROUTER_ABI = [
  "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)",
  "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)",
  "function WETH() external view returns (address)",
  "function WSVP() external view returns (address)",
];

const WSVP_ABI = [
  "function deposit() payable",
  "function withdraw(uint)",
  "function balanceOf(address) view returns (uint)",
];

function extractRevertReason(error) {
  if (error?.reason) return error.reason;
  if (error?.shortMessage) return error.shortMessage;
  if (error?.info?.error?.message) return error.info.error.message;
  return error?.message || "revert (no reason)";
}

const SVP_SYSTEM_PROMPT = `You are a precise multiple-choice quiz solver for SVP Chain — a crypto L1 focused on AI-native trading.

TOPICS:
- SVP Chain has Testnet (chainId 2517) and Mainnet (chainId 2518, rolling out).
- Public RPCs: svp-dataseed1-testnet.svpchain.org, svp-dataseeds-testnet.svpchain.org.
- Explorer: explorer.svpchain.com (Blockscout fork).
- Tooling: NovaSwap (DEX), Lendora (lending), SVP Bridge, SVP Faucet.
- Min gas: 2 Gwei.

RULES:
- Return ONLY a single integer: the 0-based index of the correct option.
- Do NOT write a letter, the option text, or any explanation.
- Do NOT add punctuation, quotes, spaces, or newlines.`;

class QuizSolver {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.enabled = !!apiKey && apiKey.startsWith("gsk_");
    this.cache = new Map();
  }
  isEnabled() { return this.enabled; }

  _buildPrompt(q) {
    const opts = (q.options || []).map((label, i) => `  [${i}] ${label}`).join("\n");
    return `Question:\n${q.question}\n\nOptions:\n${opts}\n\nReturn the 0-based index:`;
  }

  _extractIndex(text, maxIndex) {
    if (text == null) return null;
    const cleaned = String(text).trim().toLowerCase();
    const strict = cleaned.match(/^(\d+)\b/);
    if (strict) {
      const n = Number.parseInt(strict[1], 10);
      if (Number.isInteger(n) && n >= 0 && n <= maxIndex) return n;
    }
    for (const ch of cleaned) {
      if (ch >= "0" && ch <= "9") {
        const n = Number.parseInt(ch, 10);
        if (n >= 0 && n <= maxIndex) return n;
      }
    }
    return null;
  }

  async _callGroq(model, prompt) {
    const res = await axios.post(GROQ_URL, {
      model,
      messages: [
        { role: "system", content: SVP_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      max_tokens: 512,
      temperature: 0,
      stream: false,
    }, {
      timeout: 20000,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": randUA(),
      },
      validateStatus: () => true,
    });
    if (res.status >= 400) throw new Error(`Groq HTTP ${res.status}`);
    const msg = res.data?.choices?.[0]?.message || {};
    return msg.content || msg.reasoning || "";
  }

  async solve(q) {
    if (!this.enabled) return null;
    if (!q?.question || !Array.isArray(q.options) || q.options.length === 0) return null;
    const maxIndex = q.options.length - 1;
    const key = `${q.id}::${q.question}`;
    if (this.cache.has(key)) return this.cache.get(key);

    const prompt = this._buildPrompt(q);
    for (const model of [GROQ_MODEL, GROQ_FALLBACK]) {
      if (!model) continue;
      try {
        const raw = await this._callGroq(model, prompt);
        const idx = this._extractIndex(raw, maxIndex);
        if (idx !== null) {
          this.cache.set(key, idx);
          log(`   ${C.cyan}🤖 Groq [${model}] → idx=${idx}${C.reset}`);
          return idx;
        }
      } catch (e) {
        log(`   ${C.yellow}🤖 Groq [${model}] failed: ${e.message}${C.reset}`);
      }
    }
    return null;
  }

  async solveAll(questions) {
    const answers = [];
    for (const q of questions) {
      const idx = await this.solve(q);
      if (idx === null) return null;
      answers.push({ id: q.id, choice: idx });
    }
    return answers;
  }
}

class ApiError extends Error {
  constructor(code, message, httpStatus) {
    super(message); this.name = "ApiError";
    this.code = code; this.httpStatus = httpStatus;
  }
}

class SvpClient {
  constructor(token) { this.token = token || null; }

  async request(pathname, { method = "GET", body, auth = false } = {}) {
    const headers = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (auth) {
      if (!this.token) throw new ApiError(-1, "no token", 401);
      headers["authorization"] = `Bearer ${this.token}`;
    }
    headers["origin"]  = "https://rewards.svpstars.com";
    headers["referer"] = "https://rewards.svpstars.com/";

    const { status, data } = await httpJson(
      method,
      `${API_BASE}${pathname}`,
      { headers, body: body !== undefined ? JSON.stringify(body) : undefined }
    );

    if (!data || typeof data !== "object") throw new ApiError(-1, `HTTP ${status}`, status);
    if (status >= 400 || data.code !== 0) {
      throw new ApiError(data.code ?? -1, data.message || `HTTP ${status}`, status);
    }
    return data.data;
  }

  getNonce(address) { return this.request(`/auth/nonce?address=${encodeURIComponent(address)}`); }
  login({ address, signature, inviteCode }) {
    const body = { address, signature };
    if (inviteCode) body.inviteCode = inviteCode;
    return this.request("/auth/login", { method: "POST", body });
  }
  me() { return this.request("/me", { auth: true }); }
  tasks() { return this.request("/tasks", { auth: true }); }
  startTask(id) { return this.request(`/tasks/${id}/start`, { method: "POST", auth: true }); }
  verifyTask(id) { return this.request(`/tasks/${id}/verify`, { method: "POST", auth: true, body: {} }); }
  claimTask(id, body) { return this.request(`/tasks/${id}/claim`, { method: "POST", auth: true, body: body ?? {} }); }
  quizToday() { return this.request("/quiz/today", { auth: true }); }
  claimRegionReward(cat) { return this.request(`/region-rewards/${cat}/claim`, { method: "POST", auth: true, body: {} }); }
}

async function fetchAltchaEnvelope(address, tokenAddress) {
  const url = `${ALTCHA_BASE}?chain=svp-testnet` +
              `&token=${encodeURIComponent(tokenAddress)}` +
              `&address=${encodeURIComponent(address)}`;
  const { status, data } = await httpJson("GET", url, {
    headers: {
      "accept": "*/*",
      "referer": "https://www.svpchain.org/faucet",
      "origin": "https://www.svpchain.org",
    },
  });
  if (status !== 200 || !data?.parameters) throw new Error(`challenge HTTP ${status}`);
  return data;
}

async function solveAltcha(envelope) {
  const start = Date.now();
  const solution = await solveChallenge({
    challenge: envelope,
    deriveKey: pbkdf2.deriveKey,
    timeout: ALTCHA_SOLVE_TIMEOUT_MS,
  });
  if (!solution || typeof solution.counter !== "number") {
    throw new Error(`altcha gave up after ${Date.now() - start}ms`);
  }
  return solution;
}

function buildAltchaToken(envelope, solution) {
  return Buffer.from(JSON.stringify({
    challenge: envelope,
    solution: {
      counter: solution.counter,
      derivedKey: solution.derivedKey,
      time: solution.time,
    },
  })).toString("base64");
}

async function faucetClaimOne(address, tokenAddress, symbol) {
  let altchaToken;
  for (let attempt = 1; attempt <= MAX_ALTCHA_ATTEMPTS; attempt++) {
    try {
      const envelope = await fetchAltchaEnvelope(address, tokenAddress);
      const solution = await solveAltcha(envelope);
      log(`   ${C.cyan}🔐 ALTCHA solved (counter=${solution.counter}, ${Math.round(solution.time)}ms)${C.reset}`);
      altchaToken = buildAltchaToken(envelope, solution);
      break;
    } catch (e) {
      log(`   ${C.yellow}🔐 ALTCHA attempt ${attempt}/${MAX_ALTCHA_ATTEMPTS} failed: ${e.message}${C.reset}`);
      if (attempt === MAX_ALTCHA_ATTEMPTS) {
        return { ok: false, symbol, errMsg: `altcha: ${e.message}` };
      }
      await sleep(3000);
    }
  }

  const { status, data } = await httpJson("POST", FAUCET_ENDPOINT, {
    headers: {
      "content-type": "application/json",
      "origin": "https://www.svpchain.org",
      "referer": "https://www.svpchain.org/faucet",
    },
    body: JSON.stringify({
      chain: "svp-testnet",
      token: tokenAddress,
      address,
      altcha: altchaToken,
    }),
  });

  const json = data || {};
  const txHash = json.tx_hash || json.txHash || json.hash || json.data?.txHash || json.data?.tx_hash || null;
  const errMsg = json.error || json.message || json.reason || json.data?.error || json.data?.message || null;
  return { ok: status < 400 && !!txHash, txHash, status, errMsg, symbol };
}

async function faucetClaimWithRetry(address, token, attempts = MAX_CLAIM_ATTEMPTS) {
  for (let i = 1; i <= attempts; i++) {
    const r = await faucetClaimOne(address, token.address, token.symbol);
    if (r.ok) return r;
    if (r.status === 400 && /not enabled/i.test(r.errMsg || "")) return r;
    if (RETRYABLE_STATUS.has(r.status) && i < attempts) {
      const wait = r.status === 429 ? RETRY_WAIT_RATE_LIMIT : RETRY_WAIT_SERVER_ERR;
      log(`   ${C.yellow}⚠️  ${token.symbol}: HTTP ${r.status} — retry ${i}/${attempts} in ${wait / 1000}s${C.reset}`);
      await sleep(wait);
      continue;
    }
    return r;
  }
  return { ok: false, symbol: token.symbol, errMsg: "max retries exceeded" };
}

async function faucetClaimAll(address, task = null) {
  const results = [];
  let nativeHash = null;
  const taskDone = task && task.userStatus === "done";

  for (let i = 0; i < FAUCET_TOKENS.length; i++) {
    const t = FAUCET_TOKENS[i];
    if (taskDone) break;

    if (FAUCET_COOLDOWNS.isFresh(address, t.address)) {
      const ago = Math.round((Date.now() - FAUCET_COOLDOWNS.get(address, t.address)) / 60000);
      log(`   ${C.dim}⏭️  skip faucet ${t.symbol}: claimed ${ago}m ago${C.reset}`);
      continue;
    }

    try {
      const r = await faucetClaimWithRetry(address, t);
      results.push(r);
      if (r.ok) {
        log(`   ${C.green}💧 faucet ${t.symbol}: ${EXPLORER}/${r.txHash}${C.reset}`);
        FAUCET_COOLDOWNS.set(address, t.address, Date.now());
        if (t.symbol === "SVP") nativeHash = r.txHash;
      } else if (r.status === 400 && /not enabled/i.test(r.errMsg || "")) {
        log(`   ${C.yellow}🚫 faucet ${t.symbol}: disabled${C.reset}`);
      } else {
        log(`   ${C.yellow}❌ faucet ${t.symbol}: HTTP ${r.status}${r.errMsg ? ` — ${r.errMsg}` : ""}${C.reset}`);
      }
    } catch (e) {
      results.push({ ok: false, symbol: t.symbol, errMsg: e.message });
      log(`   ${C.red}❌ faucet ${t.symbol}: ${e.message}${C.reset}`);
    }

    if (i < FAUCET_TOKENS.length - 1) {
      log(`   ${C.dim}⏳ waiting ${INTER_TOKEN_DELAY / 1000}s before next token…${C.reset}`);
      await sleep(INTER_TOKEN_DELAY);
    }
  }
  return { results, nativeHash };
}

const swapLog = (...a) => log(`   ${C.cyan}🔄 [swap]${C.reset}`, ...a);

async function wrapNativeToWSVP(wallet, amountWei) {
  const wsvp = new ethers.Contract(WSVP_ADDRESS, WSVP_ABI, wallet);
  swapLog(`wrapping ${ethers.formatEther(amountWei)} SVP → WSVP…`);
  const tx = await wsvp.deposit({ value: amountWei, gasLimit: 200_000 });
  const rcpt = await tx.wait();
  if (rcpt.status !== 1) throw new Error("WSVP.deposit reverted");
  swapLog(`${C.green}✅ wrapped${C.reset} ${EXPLORER}/${tx.hash}`);
  return tx.hash;
}

async function approveToken(wallet, tokenAddress, spender) {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
  const allowance = await token.allowance(wallet.address, spender);
  if (allowance > 0n) return null;
  swapLog(`approving ${tokenAddress.slice(0, 10)}…`);
  const tx = await token.approve(spender, ethers.MaxUint256, { gasLimit: 200_000 });
  await tx.wait();
  swapLog(`${C.green}✅ approved${C.reset} ${EXPLORER}/${tx.hash}`);
  return tx.hash;
}

async function executeSwapLeg(wallet, provider, fromSymbol, toSymbol, amountIn) {
  const fromToken = TOKENS[fromSymbol];
  const toToken = TOKENS[toSymbol];
  if (!fromToken || !toToken) {
    swapLog(`${C.red}unknown token in leg ${fromSymbol}→${toSymbol}${C.reset}`);
    return null;
  }

  const router = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, wallet);
  const deadline = Math.floor(Date.now() / 1000) + 900;
  const path = [fromToken, toToken];

  let amountOutMin;
  try {
    const amounts = await router.getAmountsOut(amountIn, path);
    const out = amounts[amounts.length - 1];
    amountOutMin = (out * (100n - SWAP_SLIPPAGE_PCT)) / 100n;
    swapLog(`quote ${fromSymbol}→${toSymbol}: ${ethers.formatEther(amountIn)} in → ${out.toString()} out`);
  } catch (e) {
    swapLog(`${C.yellow}no liquidity ${fromSymbol}→${toSymbol}: ${extractRevertReason(e)}${C.reset}`);
    return null;
  }

  try { await approveToken(wallet, fromToken, ROUTER_ADDRESS); }
  catch (e) {
    swapLog(`${C.yellow}approve failed: ${extractRevertReason(e)}${C.reset}`);
    return null;
  }

  let gasLimit;
  try {
    const est = await router.swapExactTokensForTokens.estimateGas(
      amountIn, amountOutMin, path, wallet.address, deadline
    );
    gasLimit = (est * 130n) / 100n;
  } catch (e) {
    swapLog(`${C.yellow}gas est. failed (${extractRevertReason(e)}) — using 500k${C.reset}`);
    gasLimit = 500_000n;
  }

  const fee = await provider.getFeeData();
  let maxFeePerGas = fee.maxFeePerGas ?? MIN_GAS_PRICE;
  let maxPriorityFeePerGas = fee.maxPriorityFeePerGas ?? ethers.parseUnits("0.125", "gwei");
  if (maxFeePerGas < MIN_GAS_PRICE) maxFeePerGas = MIN_GAS_PRICE;

  try {
    const tx = await router.swapExactTokensForTokens(
      amountIn, amountOutMin, path, wallet.address, deadline,
      { gasLimit, type: 2, maxFeePerGas, maxPriorityFeePerGas }
    );
    const rcpt = await tx.wait();
    if (rcpt.status !== 1) throw new Error("swap reverted");
    swapLog(`${C.green}✅ ${fromSymbol}→${toSymbol}${C.reset} ${EXPLORER}/${tx.hash}`);
    return tx.hash;
  } catch (e) {
    swapLog(`${C.red}❌ ${fromSymbol}→${toSymbol} failed: ${extractRevertReason(e)}${C.reset}`);
    return null;
  }
}

async function performDistinctSwaps(privateKey, provider) {
  const wallet = new ethers.Wallet(privateKey, provider);
  const hashes = [];

  const bal = await provider.getBalance(wallet.address);
  const needWSVP = SWAP_LEGS.reduce((a, l) => a + l.amount, 0n);
  const needTotal = needWSVP + SWAP_MIN_RESERVE;
  if (bal < needTotal) {
    swapLog(`${C.yellow}insufficient SVP: have ${ethers.formatEther(bal)}, need ${ethers.formatEther(needTotal)}${C.reset}`);
    return hashes;
  }

  try { hashes.push(await wrapNativeToWSVP(wallet, needWSVP)); }
  catch (e) {
    swapLog(`${C.red}wrap failed: ${extractRevertReason(e)}${C.reset}`);
    return hashes;
  }

  try { await approveToken(wallet, WSVP_ADDRESS, ROUTER_ADDRESS); }
  catch (e) {
    swapLog(`${C.red}WSVP approve failed: ${extractRevertReason(e)}${C.reset}`);
  }

  for (const leg of SWAP_LEGS) {
    const h = await executeSwapLeg(wallet, provider, leg.from, leg.to, leg.amount);
    if (h) hashes.push(h);
    await sleep(3000);
  }

  swapLog(`${C.green}${hashes.length} swap tx(s) landed${C.reset}`);
  return hashes;
}

async function deployContract(bytecode, privateKey, provider) {
  const wallet = new ethers.Wallet(privateKey, provider);
  const bal = await provider.getBalance(wallet.address);
  log(`   🚀 deploy from ${wallet.address}`);
  log(`   💰 balance   : ${ethers.formatEther(bal)} SVP`);

  if (bal === 0n) {
    log(`   ${C.yellow}⚠️  0 balance — faucet first${C.reset}`);
    return null;
  }

  const fee = await provider.getFeeData();
  let maxFeePerGas = fee.maxFeePerGas ?? MIN_GAS_PRICE;
  let maxPriorityFeePerGas = fee.maxPriorityFeePerGas ?? ethers.parseUnits("1", "gwei");
  if (maxFeePerGas < MIN_GAS_PRICE) maxFeePerGas = MIN_GAS_PRICE;

  let gasLimit;
  try {
    const est = await provider.estimateGas({ from: wallet.address, data: bytecode });
    gasLimit = (est * 130n) / 100n;
    log(`   ⛽ gas est.  : ${est} (using ${gasLimit})`);
  } catch {
    gasLimit = GAS_LIMIT_FALLBACK;
    log(`   ${C.yellow}⛽ gas est. failed — using ${gasLimit}${C.reset}`);
  }

  const tx = await wallet.sendTransaction({
    data: bytecode, gasLimit, type: 2, maxFeePerGas, maxPriorityFeePerGas,
  });
  log(`   ${C.cyan}📜 tx: ${tx.hash}${C.reset}`);
  log(`   ${C.cyan}🔗 ${EXPLORER}/${tx.hash}${C.reset}`);

  const rcpt = await tx.wait(1);
  if (!rcpt || rcpt.status !== 1 || !rcpt.contractAddress) {
    log(`   ${C.red}❌ deploy failed${C.reset}`);
    return null;
  }

  log(`   ${C.green}✅ deployed at ${rcpt.contractAddress}${C.reset}`);
  return tx.hash;
}

async function loginAccount(privateKey) {
  const account = privateKeyToAccount(privateKey);
  const client = new SvpClient();
  const { message } = await client.getNonce(account.address);
  const signature = await account.signMessage({ message });
  const { token } = await client.login({
    address: account.address,
    signature,
    inviteCode: INVITE_CODE || undefined,
  });
  return { client: new SvpClient(token), address: account.address };
}

function flattenTasks(bundle) {
  const out = [];
  for (const cat of ["newbie", "daily", "weekly", "special"]) {
    for (const t of bundle?.[cat] ?? []) out.push({ ...t, category: cat });
  }
  return out;
}

const lendLog = (...a) => log(`   ${C.magenta}🏦 [lendora]${C.reset}`, ...a);

async function performLendoraSupply(privateKey, provider) {
  const wallet = new ethers.Wallet(privateKey, provider);

  for (const sym of ["USDC", "WBTC", "WBNB"]) {
    const cfg = CTOKENS[sym];
    if (!cfg) continue;

    const erc20 = new ethers.Contract(cfg.underlying, ERC20_ABI, wallet);
    const bal = await erc20.balanceOf(wallet.address).catch(() => 0n);
    if (bal === 0n) {
      lendLog(`${C.yellow}⏭️  skip ${sym}: zero balance${C.reset}`);
      continue;
    }

    const capRaw = ethers.parseUnits(LENDORA_MAX_SUPPLY, cfg.decimals);
    const ninetyPct = (bal * 90n) / 100n;
    const amount = ninetyPct > capRaw ? capRaw : ninetyPct;
    if (amount === 0n) continue;

    const cToken = new ethers.Contract(cfg.cToken, CTOKEN_ABI, wallet);

    try {
      const allowance = await erc20.allowance(wallet.address, cfg.cToken);
      if (allowance < amount) {
        lendLog(`approving ${sym}…`);
        const atx = await erc20.approve(cfg.cToken, ethers.MaxUint256, { gasLimit: 200_000 });
        await atx.wait();
      }
    } catch (e) {
      lendLog(`${C.yellow}${sym} approve failed — ${extractRevertReason(e)}${C.reset}`);
      continue;
    }

    const mintErc20 = cToken.getFunction("mint(uint256)");

    try {
      await mintErc20.staticCall(amount);
    } catch (e) {
      lendLog(`${C.yellow}${sym} sim failed — ${extractRevertReason(e)}${C.reset}`);
      continue;
    }

    const gasLimit = await mintErc20.estimateGas(amount)
      .then(g => (g * 130n) / 100n)
      .catch(() => 400_000n);

    lendLog(`supplying ${ethers.formatUnits(amount, cfg.decimals)} ${sym}…`);
    try {
      const tx = await mintErc20(amount, { gasLimit });
      lendLog(`${C.cyan}📜 ${EXPLORER}/${tx.hash}${C.reset}`);
      const rcpt = await tx.wait();
      if (rcpt.status === 1) {
        lendLog(`${C.green}✅ lendora supply (${sym})${C.reset} ${EXPLORER}/${tx.hash}`);
        return tx.hash;
      }
    } catch (e) {
      lendLog(`${C.yellow}${sym} mint failed — ${extractRevertReason(e)}${C.reset}`);
    }
  }

  lendLog(`${C.yellow}😕 no Lendora market accepted supply${C.reset}`);
  return null;
}

const bridgeLog = (...a) => log(`   ${C.blue}🌉 [bridge]${C.reset}`, ...a);

function encodeBridgeCalldata(dstChainId, dstToken, recipient) {
  const selector = BRIDGE_FUNCTION_SELECTOR.replace(/^0x/, "");
  const chainIdParam   = ethers.zeroPadValue(ethers.toBeHex(BigInt(dstChainId)), 32).slice(2);
  const dstTokenParam  = ethers.zeroPadValue(dstToken, 32).slice(2);
  const recipientParam = ethers.zeroPadValue(recipient, 32).slice(2);
  const reservedParam  = "0".repeat(64);
  return `0x${selector}${chainIdParam}${dstTokenParam}${recipientParam}${reservedParam}`;
}

async function performBridge(privateKey, provider) {
  const wallet = new ethers.Wallet(privateKey, provider);
  const recipient = wallet.address;

  const min = BRIDGE_AMOUNT_MIN;
  const max = BRIDGE_AMOUNT_MAX > min ? BRIDGE_AMOUNT_MAX : min;
  const span = max - min;
  const rand = span > 0n ? BigInt(Math.floor(Math.random() * Number(span))) : 0n;
  const amount = min + rand;

  const bal = await provider.getBalance(wallet.address);
  if (bal < amount + BRIDGE_MIN_NATIVE_RESERVE) {
    bridgeLog(`${C.yellow}⏭️  skip: balance too low (have ${ethers.formatEther(bal)}, need ${ethers.formatEther(amount + BRIDGE_MIN_NATIVE_RESERVE)})${C.reset}`);
    return null;
  }

  const data = encodeBridgeCalldata(BRIDGE_DEST_CHAIN_ID, BRIDGE_DST_TOKEN, recipient);

  bridgeLog(`bridging ${ethers.formatEther(amount)} SVP → chain ${BRIDGE_DEST_CHAIN_ID}`);
  bridgeLog(`data      : ${data.slice(0, 10)}…${data.slice(-16)}`);

  const fee = await provider.getFeeData();
  let maxFeePerGas = fee.maxFeePerGas ?? MIN_GAS_PRICE;
  let maxPriorityFeePerGas = fee.maxPriorityFeePerGas ?? ethers.parseUnits("0.125", "gwei");
  if (maxFeePerGas < MIN_GAS_PRICE) maxFeePerGas = MIN_GAS_PRICE;

  let gasLimit;
  try {
    const est = await provider.estimateGas({ from: wallet.address, to: BRIDGE_CONTRACT, value: amount, data });
    gasLimit = (est * 130n) / 100n;
  } catch {
    bridgeLog(`${C.yellow}⛽ gas est. failed — using 300k${C.reset}`);
    gasLimit = 300_000n;
  }

  let tx;
  try {
    tx = await wallet.sendTransaction({
      to: BRIDGE_CONTRACT, value: amount, data, gasLimit,
      type: 2, maxFeePerGas, maxPriorityFeePerGas,
    });
  } catch (e) {
    bridgeLog(`${C.red}❌ send failed — ${extractRevertReason(e)}${C.reset}`);
    return null;
  }

  bridgeLog(`${C.cyan}📜 tx: ${tx.hash}${C.reset}`);
  bridgeLog(`${C.cyan}🔗 ${EXPLORER}/${tx.hash}${C.reset}`);

  const rcpt = await tx.wait(1);
  if (!rcpt || rcpt.status !== 1) {
    bridgeLog(`${C.red}❌ reverted on-chain${C.reset}`);
    return null;
  }

  bridgeLog(`${C.green}✅ confirmed block ${rcpt.blockNumber}${C.reset}`);
  return tx.hash;
}

async function handleCheckin(client, task) {
  if (task.userStatus === "done") return;
  await client.startTask(task.id).catch(() => {});
  const r = await client.claimTask(task.id, {});
  log(`   ${C.green}📅 check-in +${r.pointsAwarded} pts${C.reset}`);
}

async function handleQuiz(client, task, solver) {
  if (task.userStatus === "done") return;

  await client.startTask(task.id).catch(() => {});
  const payload = await client.quizToday().catch(() => null);
  const questions = payload?.questions ?? [];
  if (!questions.length) { log(`   🧠 quiz: no questions`); return; }
  if (!solver.isEnabled()) { log(`   🧠 quiz: Groq disabled`); return; }

  const answers = await solver.solveAll(questions);
  if (!answers) { log(`   🧠 quiz: solver failed`); return; }

  const res = await client.claimTask(task.id, { answers });
  log(`   ${C.green}🧠 quiz +${res.pointsAwarded} pts${C.reset}`);
}

async function handleFaucet(client, task, address) {
  if (task.userStatus === "done") {
    log(`   💧 faucet task already done — skipping drips`);
    return;
  }

  log(`   💧 faucet: requesting all token drips…`);
  const { nativeHash } = await faucetClaimAll(address, task);

  if (!nativeHash) {
    log(`   ${C.yellow}😕 no native SVP drip this run${C.reset}`);
    return;
  }

  await client.startTask(task.id).catch(() => {});
  try {
    const r = await client.claimTask(task.id, { txHash: nativeHash });
    log(`   ${C.green}💧 faucet verified +${r.pointsAwarded} pts${C.reset}`);
  } catch (e) {
    log(`   ${C.red}💧 faucet claim failed: ${e.message}${C.reset}`);
  }
}

async function handleVerifyThenClaim(client, task) {
  if (task.userStatus === "done") return;

  if (task.userStatus === "todo") {
    try { await client.startTask(task.id); } catch {}
  }

  let upd;
  try { upd = await client.verifyTask(task.id); }
  catch (e) { log(`   ${C.yellow}🔍 verify: ${e.message}${C.reset}`); return; }

  const ps = upd?.productState;
  log(`   🔍 verify ${task.title} → ${upd.userStatus}` +
      (ps ? ` (${ps.progress ?? "?"}/${ps.target ?? "?"}` +
            (ps.uniqueDirectionCount != null ? `, dirs=${ps.uniqueDirectionCount}` : "") +
            (ps.reasonCode ? `, reason=${ps.reasonCode}` : "") +
            (ps.bridgeSummary
              ? `, bridge processing=${ps.bridgeSummary.processingCount ?? 0}`
              : "") +
            `)` : ""));

  if (upd.userStatus === "claimable") {
    const r = await client.claimTask(task.id, {});
    log(`   ${C.green}✅ claim ${task.title} +${r.pointsAwarded}${C.reset}`);
  }
}

async function handleGeneric(client, task) {
  if (task.userStatus === "done") return;
  if (task.userStatus === "todo") {
    await client.startTask(task.id).catch(() => {});
  } else if (task.userStatus === "claimable") {
    const r = await client.claimTask(task.id, {});
    log(`   ${C.green}✅ claim ${task.title} +${r.pointsAwarded}${C.reset}`);
  }
}

async function claimAllRegionChests(client) {
  for (const cat of ["newbie", "daily", "weekly", "special"]) {
    await jitter();
    try {
      const r = await client.claimRegionReward(cat);
      log(`   ${C.green}🎁 region [${cat}] +${r.pointsAwarded}${C.reset}`);
    } catch (e) {
      if (!/not ready|locked|already|completed|remaining/i.test(e.message)) {
        log(`   ${C.yellow}🎁 region [${cat}] skip: ${e.message}${C.reset}`);
      }
    }
  }
}

async function handleSwapTask(client, task, address, privateKey, provider) {
  if (task.userStatus === "done") {
    log(`\n${C.cyan}🔄 ─── swap_check already done ───${C.reset}`);
    return;
  }

  const progress = task.productState?.progress ?? 0;
  const target = task.productState?.target ?? 3;

  if (progress >= target) {
    log(`\n${C.cyan}🔄 ─── swap_check at ${progress}/${target} — verifying ───${C.reset}`);
    await handleVerifyThenClaim(client, task);
    return;
  }

  if (!DO_SWAP) {
    log(`\n${C.cyan}🔄 ─── swap disabled (--no-swap) — verifying only ───${C.reset}`);
    await handleVerifyThenClaim(client, task);
    return;
  }

  log(`\n${C.bold}${C.cyan}🔄 ─── swap_check: executing 3 swap legs ───${C.reset}`);
  let hashes = [];
  try { hashes = await performDistinctSwaps(privateKey, provider); }
  catch (e) { log(`   ${C.red}🔄 swap error: ${e.message}${C.reset}`); }

  if (hashes.length === 0) {
    log(`   ${C.yellow}😕 no swaps landed — verifying anyway${C.reset}`);
    await handleVerifyThenClaim(client, task);
    return;
  }

  TXHASHES.set(address, "swap_last", hashes.join(","));

  log(`   ${C.green}⏳ swaps landed — waiting 90s for indexer…${C.reset}`);
  await sleep(90_000);

  const MAX_ATTEMPTS = 6;
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    let upd;
    try { upd = await client.verifyTask(task.id); }
    catch (e) { log(`   ${C.yellow}🔍 verify ${i}/${MAX_ATTEMPTS}: ${e.message}${C.reset}`); }

    if (upd) {
      const ps = upd.productState;
      log(`   🔍 verify swap_check → ${upd.userStatus}` +
          (ps ? ` (${ps.progress ?? "?"}/${ps.target ?? "?"}` +
                (ps.uniqueDirectionCount != null ? `, dirs=${ps.uniqueDirectionCount}` : "") +
                (ps.reasonCode ? `, reason=${ps.reasonCode}` : "") + `)` : ""));

      if (upd.userStatus === "claimable") {
        const r = await client.claimTask(task.id, {});
        log(`   ${C.green}✅ claim ${task.title} +${r.pointsAwarded}${C.reset}`);
        return;
      }
      if (upd.userStatus === "done") return;
    }
    if (i < MAX_ATTEMPTS) await sleep(20_000);
  }

  log(`   ${C.yellow}😕 swap_check still not claimable after retries${C.reset}`);
}

async function handleBridgeTask(client, task, address, privateKey, provider) {
  if (task.userStatus === "done") {
    log(`\n${C.cyan}🌉 ─── bridge_check already done ───${C.reset}`);
    return;
  }

  // If the backend already records progress for THIS task period, verify only.
  // NOTE: we intentionally do NOT consult the bridge sub-API here — it returns
  // historical txs and would incorrectly skip bridging on subsequent days.
  const progress = task.productState?.progress ?? 0;
  const target = task.productState?.target ?? 1;
  const processing = task.productState?.bridgeSummary?.processingCount ?? 0;

  if (progress >= target) {
    log(`\n${C.cyan}🌉 ─── bridge progress ${progress}/${target} — verifying ───${C.reset}`);
    await handleVerifyThenClaim(client, task);
    return;
  }

  if (processing > 0) {
    log(`\n${C.cyan}🌉 ─── bridge already processing (${processing}) — verifying ───${C.reset}`);
    await handleVerifyThenClaim(client, task);
    return;
  }

  if (!DO_BRIDGE) {
    log(`\n${C.cyan}🌉 ─── bridge disabled (--no-bridge) ───${C.reset}`);
    return;
  }

  log(`\n${C.bold}${C.blue}🌉 ─── Executing bridge SVP → Arbitrum Sepolia ───${C.reset}`);
  let hash;
  try { hash = await performBridge(privateKey, provider); }
  catch (e) { log(`   ${C.red}🌉 bridge error: ${e.message}${C.reset}`); return; }

  if (!hash) {
    log(`   ${C.yellow}😕 no bridge tx sent — trying verify anyway${C.reset}`);
    await handleVerifyThenClaim(client, task);
    return;
  }

  TXHASHES.set(address, "bridge_last", hash);
  log(`   ${C.green}⏳ waiting ${BRIDGE_VERIFY_WAIT_MS / 1000}s for indexer…${C.reset}`);
  await sleep(BRIDGE_VERIFY_WAIT_MS);

  const MAX_ATTEMPTS = 6;
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    let upd;
    try { upd = await client.verifyTask(task.id); }
    catch (e) { log(`   ${C.yellow}🔍 verify ${i}/${MAX_ATTEMPTS}: ${e.message}${C.reset}`); }

    if (upd) {
      const ps = upd.productState;
      log(`   🔍 verify bridge_check → ${upd.userStatus}` +
          (ps ? ` (${ps.progress ?? "?"}/${ps.target ?? "?"}` +
                (ps.reasonCode ? `, reason=${ps.reasonCode}` : "") +
                (ps.bridgeSummary
                  ? `, bridge processing=${ps.bridgeSummary.processingCount ?? 0}`
                  : "") +
                `)` : ""));

      if (upd.userStatus === "claimable") {
        const r = await client.claimTask(task.id, {});
        log(`   ${C.green}✅ claim ${task.title} +${r.pointsAwarded}${C.reset}`);
        return;
      }
      if (upd.userStatus === "done") return;
    }
    if (i < MAX_ATTEMPTS) await sleep(20_000);
  }

  log(`   ${C.yellow}😕 bridge_check still not claimable after retries${C.reset}`);
}

async function runAccount(account, idx, total, ctx) {
  const { solver, bytecode, provider } = ctx;

  log(`\n${C.bold}🏦 ═════ [ ${idx + 1}/${total} ] ${account.label} ═════${C.reset}`);

  let conn;
  try { conn = await loginAccount(account.privateKey); }
  catch (e) { log(`${C.red}🔐 LOGIN FAIL: ${e.message}${C.reset}`); return; }

  const { client, address } = conn;
  log(`📍 Address: ${address}`);

  try {
    const me = await client.me();
    log(`📊 Profile: points=${me.totalPoints} invites=${me.validInviteCount} rank=#${me.rank}`);
  } catch (e) { log(`📊 me(): ${e.message}`); }

  let tasks = [];
  try { tasks = flattenTasks(await client.tasks()); }
  catch (e) { log(`📋 tasks(): ${e.message}`); return; }
  log(`📋 Fetched ${tasks.length} tasks`);

  if (DRY_RUN) {
    for (const t of tasks) {
      const mark = t.locked ? "🔒" : t.userStatus === "done" ? "✅" : "•";
      log(`  ${mark} [${t.category}] ${t.title} — ${t.userStatus} (${t.actionType})`);
    }
    return;
  }

  const faucetTask = tasks.find(t => t.actionType === "faucet_claim");
  if (faucetTask && faucetTask.userStatus !== "done") {
    log(`\n${C.bold}${C.green}💧 ─── Step 1: Faucet ───${C.reset}`);
    try { await handleFaucet(client, faucetTask, address); }
    catch (e) { log(`   ${C.red}💧 faucet error: ${e.message}${C.reset}`); }
    try { tasks = flattenTasks(await client.tasks()); } catch {}
    if (provider) {
      const bal = await provider.getBalance(address);
      log(`   ${C.cyan}💰 Balance after faucet: ${ethers.formatEther(bal)} SVP${C.reset}`);
    }
  } else if (faucetTask) {
    log(`\n${C.cyan}💧 ─── Step 1: Faucet skipped (done) ───${C.reset}`);
  }

  const checkinTask = tasks.find(t => t.actionType === "checkin");
  if (checkinTask && checkinTask.userStatus !== "done") {
    log(`\n${C.bold}${C.green}📅 ─── Step 2: Check-in ───${C.reset}`);
    try { await handleCheckin(client, checkinTask); }
    catch (e) { log(`   ${C.red}📅 checkin error: ${e.message}${C.reset}`); }
    try { tasks = flattenTasks(await client.tasks()); } catch {}
  } else if (checkinTask) {
    log(`\n${C.cyan}📅 ─── Step 2: Check-in skipped (done) ───${C.reset}`);
  }

  const quizTask = tasks.find(t => t.actionType === "quiz");
  if (quizTask && quizTask.userStatus !== "done") {
    log(`\n${C.bold}${C.green}🧠 ─── Step 3: Quiz ───${C.reset}`);
    try { await handleQuiz(client, quizTask, solver); }
    catch (e) { log(`   ${C.red}🧠 quiz error: ${e.message}${C.reset}`); }
    try { tasks = flattenTasks(await client.tasks()); } catch {}
  } else if (quizTask) {
    log(`\n${C.cyan}🧠 ─── Step 3: Quiz skipped (done) ───${C.reset}`);
  }

  const swapTask = tasks.find(t => t.actionType === "swap_check");
  if (swapTask && swapTask.userStatus !== "done") {
    log(`\n${C.bold}${C.green}🔄 ─── Step 4: Auto-Swap ───${C.reset}`);
    log(`→ [${swapTask.category}] ${swapTask.title} (${swapTask.actionType}, ${swapTask.userStatus})`);
    try { await handleSwapTask(client, swapTask, address, account.privateKey, provider); }
    catch (e) { log(`   ${C.red}🔄 swap error: ${e.message}${C.reset}`); }
    try { tasks = flattenTasks(await client.tasks()); } catch {}
  } else if (swapTask) {
    log(`\n${C.cyan}🔄 ─── Step 4: Auto-Swap skipped (done) ───${C.reset}`);
  }

  const lendTask = tasks.find(t => t.actionType === "lending_check");
  if (!DO_LEND) {
    log(`\n${C.cyan}🏦 ─── Step 5: Lendora disabled ───${C.reset}`);
  } else if (!lendTask) {
    log(`\n${C.cyan}🏦 ─── Step 5: no lending_check ───${C.reset}`);
  } else if (lendTask.userStatus === "done") {
    log(`\n${C.cyan}🏦 ─── Step 5: Lendora skipped (done) ───${C.reset}`);
  } else {
    const progress = lendTask.productState?.progress ?? 0;
    const target = lendTask.productState?.target ?? 1;
    if (progress < target) {
      log(`\n${C.bold}${C.green}🏦 ─── Step 5: Lendora supply ───${C.reset}`);
      try {
        const hash = await performLendoraSupply(account.privateKey, provider);
        if (hash) { await sleep(15000); try { tasks = flattenTasks(await client.tasks()); } catch {} }
      } catch (e) { log(`   ${C.red}🏦 lendora error: ${e.message}${C.reset}`); }
    } else {
      log(`\n${C.cyan}🏦 ─── Step 5: lending_check at ${progress}/${target} ───${C.reset}`);
    }
  }

  const bridgeTask = tasks.find(t => t.actionType === "bridge_check");
  if (bridgeTask && bridgeTask.userStatus !== "done") {
    log(`\n${C.bold}${C.green}🌉 ─── Step 6: Bridge ───${C.reset}`);
    await handleBridgeTask(client, bridgeTask, address, account.privateKey, provider);
    try { tasks = flattenTasks(await client.tasks()); } catch {}
  } else if (bridgeTask) {
    log(`\n${C.cyan}🌉 ─── Step 6: Bridge skipped (done) ───${C.reset}`);
  }

  log(`\n${C.bold}${C.green}📋 ─── Step 7: Remaining tasks ───${C.reset}`);
  let didAnything = false;
  for (const t of tasks) {
    if (SKIP_ACTIONS.has(t.actionType)) continue;
    if (t.userStatus === "done") continue;

    await jitter();
    log(`→ [${t.category}] ${t.title} (${t.actionType}, ${t.userStatus})`);
    didAnything = true;

    try {
      switch (t.actionType) {
        case "swap_check":
        case "lending_check":
        case "bridge_check":
        case "onchain_tx_count":
          await handleVerifyThenClaim(client, t);
          break;

        case "contract_deploy": {
          const cached = TXHASHES.get(address, "contract_deploy");
          if (cached) {
            log(`   ${C.cyan}📦 using cached deploy tx ${cached}${C.reset}`);
            try {
              await client.startTask(t.id).catch(() => {});
              const r = await client.claimTask(t.id, { txHash: cached });
              log(`   ${C.green}✅ claim ${t.title} +${r.pointsAwarded}${C.reset}`);
            } catch (e) {
              log(`   ${C.yellow}📦 claim ${t.title}: ${e.message}${C.reset}`);
            }
          } else {
            log(`   ${C.dim}📦 no cached deploy tx — Step 8 will deploy${C.reset}`);
          }
          break;
        }

        default:
          await handleGeneric(client, t);
      }
    } catch (e) {
      log(`   ${C.red}❌ ${t.title}: ${e.message}${C.reset}`);
    }
  }
  if (!didAnything) log(`   ${C.dim}(nothing left)${C.reset}`);

  const deployTask = tasks.find(t => t.actionType === "contract_deploy");
  const deployDone = deployTask && deployTask.userStatus === "done";

  if (deployDone) {
    log(`\n${C.cyan}🚀 ─── Step 8: Deploy skipped (task done) ───${C.reset}`);
  } else if (!SKIP_DEPLOY && bytecode) {
    if (TXHASHES.has(address, "contract_deploy")) {
      const cached = TXHASHES.get(address, "contract_deploy");
      log(`\n${C.cyan}🚀 ─── Step 8: Deploy skipped (cached: ${cached.slice(0, 10)}…) ───${C.reset}`);

      if (deployTask && deployTask.userStatus !== "done") {
        try {
          await client.startTask(deployTask.id).catch(() => {});
          const v = await client.verifyTask(deployTask.id);
          log(`   🔍 verify ${deployTask.title} → ${v.userStatus}` +
              (v.productState ? ` (${v.productState.progress ?? "?"}/${v.productState.target ?? "?"}${v.productState.reasonCode ? `, reason=${v.productState.reasonCode}` : ""})` : ""));
        } catch (e) {
          log(`   ${C.yellow}🔍 verify: ${e.message}${C.reset}`);
        }

        try {
          const r = await client.claimTask(deployTask.id, { txHash: cached });
          log(`   ${C.green}✅ claim ${deployTask.title} +${r.pointsAwarded}${C.reset}`);
        } catch (e) {
          log(`   ${C.yellow}📦 claim: ${e.message}${C.reset}`);
        }
      }
    } else {
      log(`\n${C.bold}${C.green}🚀 ─── Step 8: Deploy contract (LAST) ───${C.reset}`);
      try {
        const hash = await deployContract(bytecode, account.privateKey, provider);
        if (hash) {
          TXHASHES.set(address, "contract_deploy", hash);
          log(`   ${C.green}✔ cached${C.reset}`);
          if (deployTask && deployTask.userStatus !== "done") {
            await sleep(5000);
            try {
              await client.startTask(deployTask.id).catch(() => {});
              await handleVerifyThenClaim(client, deployTask);
              try {
                const r = await client.claimTask(deployTask.id, { txHash: hash });
                log(`   ${C.green}✅ claim ${deployTask.title} +${r.pointsAwarded}${C.reset}`);
              } catch (e) {
                log(`   ${C.yellow}📦 claim: ${e.message}${C.reset}`);
              }
            } catch {}
          }
        }
      } catch (e) { log(`   ${C.red}🚀 deploy error: ${e.message}${C.reset}`); }
    }
  } else if (!bytecode) {
    log(`\n${C.cyan}🚀 ─── Step 8: Deploy skipped (no bytecode.txt) ───${C.reset}`);
  } else if (SKIP_DEPLOY) {
    log(`\n${C.cyan}🚀 ─── Step 8: Deploy skipped (--skip-deploy) ───${C.reset}`);
  }

  log(`\n${C.bold}${C.green}🎁 ─── Step 9: Region chests ───${C.reset}`);
  await claimAllRegionChests(client);
}

function nextRunTime() {
  const now = new Date();
  const next = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    RESET_HOUR, 0, 0, 0
  ));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m ${s % 60}s`;
}

async function sleepUntilNextRun() {
  const next = nextRunTime();
  log(`\n${C.bold}${C.cyan}⏰ Next run: ${next.toISOString()}${C.reset}`);
  while (true) {
    const remaining = next.getTime() - Date.now();
    if (remaining <= 0) return;
    log(`${C.dim}😴 Sleeping… ${fmtDuration(remaining)} remaining${C.reset}`);
    await sleep(Math.min(remaining, 30 * 60 * 1000));
  }
}

async function runCycle(ctx, cycleNum) {
  log(`\n${C.bold}${C.cyan}🔄 ═══════════ CYCLE #${cycleNum} — ${new Date().toISOString()} ═══════════${C.reset}`);
  const { accounts } = ctx;
  for (let i = 0; i < accounts.length; i++) {
    try { await runAccount(accounts[i], i, accounts.length, ctx); }
    catch (e) { log(`${C.red}💥 Account ${accounts[i].label} crashed: ${e.message}${C.reset}`); }
    if (i < accounts.length - 1) {
      log(`\n⏳ Cooldown ${COOLDOWN_BETWEEN_ACCOUNTS / 1000}s…`);
      await sleep(COOLDOWN_BETWEEN_ACCOUNTS);
    }
  }
  log(`\n${C.green}${C.bold}✅ Cycle #${cycleNum} complete.${C.reset}`);
}

async function main() {
  log(`${C.cyan}${C.bold}🌟 SVP Rewards — daily auto-farmer (v4.1)${C.reset}`);
  log(`⛓️  Chain ID  : ${CHAIN_ID}`);
  log(`🌐 RPC       : ${RPC_URL}`);
  log(`🔀 Router    : ${ROUTER_ADDRESS}`);
  log(`🌉 Bridge    : ${BRIDGE_CONTRACT}`);
  log(`🧪 Dry run   : ${DRY_RUN ? "YES" : "no"}`);
  log(`🔄 Run mode  : ${RUN_ONCE ? "ONCE" : "LOOP (daily)"}`);
  log(`💱 Do swap   : ${DO_SWAP ? "YES" : "no"}`);
  log(`🏦 Do lend   : ${DO_LEND ? "YES" : "no"}`);
  log(`🌉 Do bridge : ${DO_BRIDGE ? "YES" : "no"}`);
  if (ONLY_ADDR) log(`🎯 Only addr : ${ONLY_ADDR}`);
  log("");

  const groqKey = loadGroqKey();
  const solver = new QuizSolver(groqKey);
  log(solver.isEnabled() ? `${C.green}🧠 Quiz solver: enabled (${GROQ_MODEL})${C.reset}` : `${C.yellow}🧠 Quiz solver: disabled${C.reset}`);

  const accounts = loadAccounts();
  log(`👥 Loaded ${accounts.length} account(s)`);
  if (accounts.length === 0) throw new Error("No valid accounts.");

  const bytecode = loadBytecode();
  if (bytecode) log(`${C.green}📦 Bytecode: ${(bytecode.length - 2) / 2} bytes${C.reset}`);
  else log(`${C.yellow}📦 Bytecode: not found${C.reset}`);

  let provider = null;
  if ((bytecode && !SKIP_DEPLOY) || DO_LEND || DO_BRIDGE || DO_SWAP) {
    provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true });
    try {
      const net = await provider.getNetwork();
      if (Number(net.chainId) !== CHAIN_ID) throw new Error(`chainId ${net.chainId}`);
      log(`${C.green}🌐 RPC OK: chainId ${net.chainId}${C.reset}`);
    } catch (e) {
      log(`${C.red}🌐 RPC fail: ${e.message}${C.reset}`);
      provider = null;
    }
  }

  const ctx = { solver, bytecode, provider, accounts };

  if (RUN_ONCE) {
    await runCycle(ctx, 1);
    log(`\n${C.green}${C.bold}✅ --once given, exiting.${C.reset}`);
    return;
  }

  log(`\n${C.bold}${C.cyan}🚀 Starting daily loop. Ctrl+C to stop.${C.reset}`);
  let cycle = 1;
  while (true) {
    try { await runCycle(ctx, cycle); cycle++; }
    catch (e) { log(`${C.red}💥 Cycle crashed: ${e.message}${C.reset}`); }
    await sleepUntilNextRun();
  }
}

main().catch((e) => {
  console.error(`${C.red}💀 Fatal: ${e.message}${C.reset}`);
  process.exit(1);
});