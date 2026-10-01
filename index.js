import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { privateKeyToAccount } from "viem/accounts";
import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { solveChallenge } from "altcha-lib";
import { deriveKey as pbkdf2DeriveKey } from "altcha-lib/algorithms/pbkdf2";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ACCOUNTS_FILE        = "accounts.json";
const GROQ_FILE            = "groq.txt";
const TXHASH_FILE          = "txhashes.json";
const FAUCET_COOLDOWN_FILE = "faucet_cooldowns.json";
const PROXY_FILE           = "proxy.txt";

const API_BASE        = "https://rewards.svpstars.com/api/v1";
const FAUCET_ENDPOINT = "https://www.svpchain.org/api/claim";
const ALTCHA_BASE     = "https://www.svpchain.org/api/altcha/challenge";
const GROQ_URL        = "https://api.groq.com/openai/v1/chat/completions";
const EXPLORER        = "https://explorer.svpchain.com/tx";
const EXPLORER_API    = "https://explorer.svpchain.com/api";

const CHAIN_ID = 2517;
const RPC_URLS = [
  process.env.RPC_URL || "https://svp-dataseed1-testnet.svpchain.org",
  "https://svp-dataseeds-testnet.svpchain.org",
].filter(Boolean);

const MIN_GAS_PRICE = ethers.parseUnits("2", "gwei");

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

const INTER_TOKEN_DELAY       = 10_000;
const RETRY_WAIT_SERVER_ERR   = 15_000;
const RETRYABLE_STATUS        = new Set([500, 502, 503, 504]);
const MAX_CLAIM_ATTEMPTS      = 3;
const MAX_ALTCHA_ATTEMPTS     = 3;
const ALTCHA_SOLVE_TIMEOUT_MS = 45_000;
const FAUCET_COOLDOWN_MS      = 24 * 60 * 60 * 1000;

const MAX_QUIZ_ATTEMPTS        = 4;
const MAX_SWAP_POLL_ATTEMPTS   = 15;
const MAX_BRIDGE_POLL_ATTEMPTS = 15;
const MAX_LEND_POLL_ATTEMPTS   = 15;
const POLL_INTERVAL_MS         = 60_000;

const PRE_SLEEP_SWEEP_WAIT_MS = 5 * 60 * 1000;

const RPC_CALL_TIMEOUT_MS = 15_000;

const args    = process.argv.slice(2);
const getArg  = (name, fb = null) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fb; };
const hasFlag = (name) => args.includes(name);

const DRY_RUN     = hasFlag("--dry");
const DO_LEND     = !hasFlag("--no-lend");
const DO_BRIDGE   = !hasFlag("--no-bridge");
const DO_SWAP     = !hasFlag("--no-swap");
const RUN_ONCE    = hasFlag("--once");
const RESET_HOUR  = Number.parseInt(getArg("--reset-hour", "0"), 10);
const ONLY_ADDR   = (getArg("--only", "") || "").toLowerCase() || null;
const SKIP_MENU   = hasFlag("--no-menu");
const MENU_PROXY  = getArg("--proxy");

const JITTER_MIN = 800;
const JITTER_MAX = 2500;
const COOLDOWN_BETWEEN_ACCOUNTS = 30_000;

const SKIP_ACTIONS = new Set([
  "bind_x", "x_follow", "tg_join", "discord_join", "tweet",
  "contract_deploy",
  "swap_check", "lending_check", "bridge_check",
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

let PROXY_LIST = [];
let PROXY_INDEX = 0;
let MENU_PROXY_VALUE = "no";

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

function normalizeProxy(line) {
  let s = line.trim();
  if (!s || s.startsWith("#")) return null;
  if (!/^[a-z]+:\/\//i.test(s)) {
    const parts = s.split(":");
    if (parts.length === 4) s = `http://${parts[2]}:${parts[3]}@${parts[0]}:${parts[1]}`;
    else s = `http://${s}`;
  }
  return s;
}

function loadProxies() {
  const t = readText(PROXY_FILE);
  if (!t) return [];
  return t.split(/\r?\n/).map(normalizeProxy).filter(Boolean);
}

function makeProxyAgent(url) {
  if (url.startsWith("socks")) return new SocksProxyAgent(url);
  return new HttpsProxyAgent(url);
}

function nextProxyAgent() {
  if (PROXY_LIST.length === 0) return null;
  const url = PROXY_LIST[PROXY_INDEX % PROXY_LIST.length];
  PROXY_INDEX++;
  try { return makeProxyAgent(url); }
  catch { return null; }
}

function agentForUrl(url, useProxy) {
  if (!useProxy) return undefined;
  return nextProxyAgent() || undefined;
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
    clearFaucetKeys(wallet) {
      const key = wallet.toLowerCase();
      if (!data[key]) return 0;
      let removed = 0;
      for (const k of Object.keys(data[key])) {
        if (k.startsWith("faucet_")) {
          delete data[key][k];
          removed++;
        }
      }
      if (removed > 0) saveJson(TXHASH_FILE, data);
      return removed;
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

async function httpJson(method, url, { headers, body, useProxy = false } = {}) {
  const res = await axios.request({
    method, url,
    headers: baseHeaders(headers),
    data: body,
    timeout: 30000,
    validateStatus: () => true,
    httpsAgent: agentForUrl(url, useProxy),
    proxy: false,
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

async function safeGetBalance(provider, address) {
  try { return await provider.getBalance(address); }
  catch { return null; }
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

const SVP_SYSTEM_PROMPT = `You are a precise multiple-choice quiz solver for SVP Chain.

SVP CHAIN FACTS:
- The smallest denomination of SVP is asvp. 1 SVP = 10^18 asvp.
- The SVP testnet bridge from Ethereum Sepolia to SVPChain is LIVE.
- Slinky is SVP Chain's oracle module. Missing Slinky data causes validators to produce invalid vote extensions and be jailed.
- SVP Chain Testnet chainId is 2517. Mainnet chainId is 2518.
- Public RPCs: svp-dataseed1-testnet.svpchain.org, svp-dataseeds-testnet.svpchain.org.
- Explorer: explorer.svpchain.com.
- Tooling: NovaSwap, Lendora, SVP Bridge, SVP Faucet.
- Minimum gas is 2 Gwei.

Do not assume that because something is true on Ethereum, it is true on SVP Chain.

Return ONLY a single integer: the 0-based index of the correct option. No explanation, no punctuation, no extra text.`;

const KNOWN_ANSWERS = [
  { match: /missing Slinky causes invalid vote extensions/i, answer: 0 },
  { match: /Testnet bridge deposit from Ethereum Sepolia to SVPChain/i, answer: 0 },
  { match: /smallest denomination of SVP/i, answer: 1 },
];

function buildRetryHint(attempt) {
  const base = "The previous attempt was marked incorrect by the grader.";
  if (attempt === 2) {
    return base + " Re-read every question and every option extremely carefully. Reconsider from scratch.";
  }
  if (attempt === 3) {
    return base + " Take a completely different interpretive angle on each question. If your earlier reasoning led you to one option, seriously consider that the correct answer may be a different one.";
  }
  return base + " Answer as if you had never seen these questions before. Eliminate options systematically: first rule out the obviously wrong ones, then examine the remaining options against the exact wording of the question. Pay special attention to subtle qualifiers.";
}

class QuizSolver {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.enabled = !!apiKey && apiKey.startsWith("gsk_");
    this.cache = new Map();
  }
  isEnabled() { return this.enabled; }

  _buildPrompt(q, displayOptions) {
    const opts = displayOptions.map((o, i) => `  [${i}] ${o.text}`).join("\n");
    return `Question:\n${q.question}\n\nOptions:\n${opts}\n\nReturn the 0-based index:`;
  }

  _extractIndex(text, maxIndex) {
    if (text == null) return null;
    const cleaned = String(text).trim();

    const strict = cleaned.match(/^(\d+)\s*$/);
    if (strict) {
      const n = Number.parseInt(strict[1], 10);
      if (Number.isInteger(n) && n >= 0 && n <= maxIndex) return n;
    }

    const lines = cleaned.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length > 0) {
      const lastLine = lines[lines.length - 1];
      const m = lastLine.match(/^(\d+)\b/);
      if (m) {
        const n = Number.parseInt(m[1], 10);
        if (Number.isInteger(n) && n >= 0 && n <= maxIndex) return n;
      }
    }

    const digits = [...cleaned.matchAll(/\b(\d+)\b/g)]
      .map(m => Number.parseInt(m[1], 10))
      .filter(n => n >= 0 && n <= maxIndex);
    if (digits.length >= 1) return digits[digits.length - 1];

    return null;
  }

  async _callGroq(model, prompt, { temperature = 0, extraSystem = "" } = {}) {
    const system = extraSystem
      ? `${SVP_SYSTEM_PROMPT}\n\nADDITIONAL INSTRUCTION:\n${extraSystem}`
      : SVP_SYSTEM_PROMPT;

    const res = await axios.post(GROQ_URL, {
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
      max_tokens: 512,
      temperature,
      stream: false,
    }, {
      timeout: 20000,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": randUA(),
      },
      validateStatus: () => true,
      httpsAgent: agentForUrl(GROQ_URL, MENU_PROXY_VALUE === "yes"),
      proxy: false,
    });
    if (res.status >= 400) throw new Error(`Groq HTTP ${res.status}`);
    const msg = res.data?.choices?.[0]?.message || {};
    return msg.content || msg.reasoning || "";
  }

  async solve(q, opts = {}) {
    if (!this.enabled) return null;
    if (!q?.question || !Array.isArray(q.options) || q.options.length === 0) return null;
    const maxIndex = q.options.length - 1;

    for (const k of KNOWN_ANSWERS) {
      if (k.match.test(q.question) && k.answer >= 0 && k.answer <= maxIndex) {
        log(`   ${C.green}🧠 known answer for "${q.question.slice(0, 50)}…" → ${k.answer}${C.reset}`);
        return k.answer;
      }
    }

    let displayOptions = q.options.map((text, i) => ({ text, originalIndex: i }));
    if (opts.shuffleOptions) {
      for (let i = displayOptions.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [displayOptions[i], displayOptions[j]] = [displayOptions[j], displayOptions[i]];
      }
    }

    const tag = `${opts.temperature ?? 0}|${opts.shuffleOptions ? 1 : 0}`;
    const key = `${tag}::${q.id}::${q.question}`;
    if (!opts.cacheBust && this.cache.has(key)) return this.cache.get(key);

    const prompt = this._buildPrompt(q, displayOptions);
    for (const model of [GROQ_MODEL, GROQ_FALLBACK]) {
      if (!model) continue;
      try {
        const raw = await this._callGroq(model, prompt, opts);
        const displayIdx = this._extractIndex(raw, maxIndex);
        if (displayIdx !== null) {
          const originalIdx = displayOptions[displayIdx].originalIndex;
          this.cache.set(key, originalIdx);
          const tag2 = (opts.temperature ?? 0) > 0 ? ` t=${opts.temperature.toFixed(2)}` : "";
          log(`   ${C.cyan}🤖 Groq [${model}${tag2}] → idx=${originalIdx}${C.reset}`);
          return originalIdx;
        }
      } catch (e) {
        log(`   ${C.yellow}🤖 Groq [${model}] failed: ${e.message}${C.reset}`);
      }
    }
    return null;
  }

  async solveAll(questions, opts = {}) {
    const answers = [];
    for (const q of questions) {
      const idx = await this.solve(q, opts);
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
      { headers, body: body !== undefined ? JSON.stringify(body) : undefined, useProxy: MENU_PROXY_VALUE === "yes" }
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
    useProxy: MENU_PROXY_VALUE === "yes",
  });
  if (status !== 200 || !data?.parameters) throw new Error(`challenge HTTP ${status}`);
  return data;
}

async function solveAltcha(envelope) {
  const start = Date.now();
  const solution = await solveChallenge({
    challenge: envelope,
    deriveKey: pbkdf2DeriveKey,
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

  let status = 0, data = {};
  try {
    const r = await httpJson("POST", FAUCET_ENDPOINT, {
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
      useProxy: MENU_PROXY_VALUE === "yes",
    });
    status = r.status; data = r.data;
  } catch (e) {
    return { ok: false, symbol, status: 0, errMsg: e.message };
  }

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
    if (r.status === 400 && /already|too soon|cooldown|recently/i.test(r.errMsg || "")) return r;
    if (r.status === 429) return r;

    if (RETRYABLE_STATUS.has(r.status) && i < attempts) {
      log(`   ${C.yellow}⚠️  ${token.symbol}: HTTP ${r.status} — retry ${i}/${attempts} in ${RETRY_WAIT_SERVER_ERR / 1000}s${C.reset}`);
      await sleep(RETRY_WAIT_SERVER_ERR);
      continue;
    }
    return r;
  }
  return { ok: false, symbol: token.symbol, errMsg: "max retries exceeded" };
}

async function findRecentFaucetTx(address) {
  const FAUCET_WALLET = "0x8b52753dcbad46925821f02b7b7d90bad8804bfe";
  try {
    const url = `${EXPLORER_API}?module=account&action=tokentx` +
                `&address=${encodeURIComponent(address)}` +
                `&sort=desc&page=1&offset=50`;
    const { status, data } = await httpJson("GET", url, {
      headers: { accept: "application/json" },
      useProxy: MENU_PROXY_VALUE === "yes",
    });
    if (status !== 200) return null;
    const items = data?.result;
    if (!Array.isArray(items) || items.length === 0) return null;

    for (const tx of items) {
      if (!tx?.hash) continue;
      if ((tx.to || "").toLowerCase() !== address.toLowerCase()) continue;
      if ((tx.from || "").toLowerCase() !== FAUCET_WALLET) continue;
      return tx.hash;
    }
    return null;
  } catch {
    return null;
  }
}

async function faucetClaimAll(address, task = null) {
  const results = [];
  const txHashes = [];
  const taskDone = task && task.userStatus === "done";

  for (let i = 0; i < FAUCET_TOKENS.length; i++) {
    const t = FAUCET_TOKENS[i];
    if (taskDone) break;

    if (FAUCET_COOLDOWNS.isFresh(address, t.address)) {
      const ago = Math.round((Date.now() - FAUCET_COOLDOWNS.get(address, t.address)) / 60000);
      log(`   ${C.dim}⏭️  skip faucet ${t.symbol}: claimed ${ago}m ago${C.reset}`);

      let cached = TXHASHES.get(address, `faucet_${t.symbol}`);
      if (!cached) cached = TXHASHES.get(address, "faucet_last");
      if (!cached) {
        cached = await findRecentFaucetTx(address);
        if (cached) {
          log(`   ${C.cyan}💧 recovered ${t.symbol} tx from explorer: ${cached}${C.reset}`);
          TXHASHES.set(address, `faucet_${t.symbol}`, cached);
        }
      }
      if (cached) txHashes.push({ symbol: t.symbol, hash: cached });
      continue;
    }

    try {
      const r = await faucetClaimWithRetry(address, t);
      results.push(r);
      if (r.ok) {
        log(`   ${C.green}💧 faucet ${t.symbol}: ${EXPLORER}/${r.txHash}${C.reset}`);
        FAUCET_COOLDOWNS.set(address, t.address, Date.now());
        TXHASHES.set(address, `faucet_${t.symbol}`, r.txHash);
        TXHASHES.set(address, "faucet_last", r.txHash);
        txHashes.push({ symbol: t.symbol, hash: r.txHash });
      } else if (r.status === 400 && /not enabled/i.test(r.errMsg || "")) {
        log(`   ${C.yellow}🚫 faucet ${t.symbol}: disabled${C.reset}`);
      } else if (r.status === 429) {
        log(`   ${C.dim}⏭️  faucet ${t.symbol}: rate-limited (already claimed recently)${C.reset}`);
        FAUCET_COOLDOWNS.set(address, t.address, Date.now());
        const cached = TXHASHES.get(address, `faucet_${t.symbol}`) || TXHASHES.get(address, "faucet_last");
        if (cached) txHashes.push({ symbol: t.symbol, hash: cached });
      } else if (r.status === 400 && /already|too soon|cooldown|recently/i.test(r.errMsg || "")) {
        log(`   ${C.dim}⏭️  faucet ${t.symbol}: cooldown — ${r.errMsg}${C.reset}`);
        FAUCET_COOLDOWNS.set(address, t.address, Date.now());
        const cached = TXHASHES.get(address, `faucet_${t.symbol}`) || TXHASHES.get(address, "faucet_last");
        if (cached) txHashes.push({ symbol: t.symbol, hash: cached });
      } else {
        log(`   ${C.yellow}❌ faucet ${t.symbol}: HTTP ${r.status}${r.errMsg ? ` — ${r.errMsg}` : ""}${C.reset}`);
      }
    } catch (e) {
      results.push({ ok: false, symbol: t.symbol, errMsg: e.message });
      log(`   ${C.red}❌ faucet ${t.symbol}: ${e.message}${C.reset}`);
    }

    if (i < FAUCET_TOKENS.length - 1) {
      await sleep(INTER_TOKEN_DELAY);
    }
  }
  return { results, txHashes, anySuccess: txHashes.length > 0 };
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

  let fee = {};
  try { fee = await provider.getFeeData(); } catch {}
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

  const bal = await safeGetBalance(provider, wallet.address);
  if (bal == null) {
    swapLog(`${C.yellow}balance check failed — aborting swaps${C.reset}`);
    return hashes;
  }
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

  const bal = await safeGetBalance(provider, wallet.address);
  if (bal == null) {
    bridgeLog(`${C.yellow}balance check failed — skipping bridge${C.reset}`);
    return null;
  }
  if (bal < amount + BRIDGE_MIN_NATIVE_RESERVE) {
    bridgeLog(`${C.yellow}⏭️  skip: balance too low (have ${ethers.formatEther(bal)}, need ${ethers.formatEther(amount + BRIDGE_MIN_NATIVE_RESERVE)})${C.reset}`);
    return null;
  }

  const data = encodeBridgeCalldata(BRIDGE_DEST_CHAIN_ID, BRIDGE_DST_TOKEN, recipient);

  bridgeLog(`bridging ${ethers.formatEther(amount)} SVP → chain ${BRIDGE_DEST_CHAIN_ID}`);
  bridgeLog(`data      : ${data.slice(0, 10)}…${data.slice(-16)}`);

  let fee = {};
  try { fee = await provider.getFeeData(); } catch {}
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

  let lastSig = null;

  for (let attempt = 1; attempt <= MAX_QUIZ_ATTEMPTS; attempt++) {
    const isRetry = attempt > 1;
    const opts = isRetry
      ? {
          temperature: 0.4 + (attempt - 2) * 0.15,
          extraSystem: buildRetryHint(attempt),
          shuffleOptions: true,
          cacheBust: true,
        }
      : { temperature: 0 };

    const answers = await solver.solveAll(questions, opts);
    if (!answers) {
      log(`   ${C.yellow}🧠 quiz: solver returned no answers on attempt ${attempt}${C.reset}`);
      return;
    }

    const sig = answers.map(a => a.choice).join(",");
    if (isRetry && sig === lastSig) {
      log(`   ${C.yellow}🧠 quiz: model repeated the same answers — forcing new sample${C.reset}`);
      continue;
    }
    lastSig = sig;

    try {
      const res = await client.claimTask(task.id, { answers });
      log(`   ${C.green}🧠 quiz +${res.pointsAwarded} pts${C.reset}` + (attempt > 1 ? ` (attempt ${attempt})` : ""));
      return;
    } catch (e) {
      const msg = e.message || "";
      const isRetryable = /incorrect|try again|wrong/i.test(msg);
      if (isRetryable && attempt < MAX_QUIZ_ATTEMPTS) {
        log(`   ${C.yellow}🧠 quiz attempt ${attempt}/${MAX_QUIZ_ATTEMPTS} rejected — retrying with fresh answers${C.reset}`);
        await sleep(3000);
        continue;
      }
      log(`   ${C.red}🧠 quiz error: ${msg}${C.reset}`);
      return;
    }
  }

  log(`   ${C.red}🧠 quiz: gave up after ${MAX_QUIZ_ATTEMPTS} attempts${C.reset}`);
}

async function handleFaucet(client, task, address) {
  if (task.userStatus === "done") {
    log(`   💧 faucet task already done — skipping drips`);
    return true;
  }

  log(`   💧 faucet: requesting all token drips…`);
  const { txHashes } = await faucetClaimAll(address, task);

  await client.startTask(task.id).catch(() => {});

  if (txHashes.length === 0) {
    log(`   ${C.red}😕 no faucet tx available (fresh or recovered) — cannot claim${C.reset}`);
    return false;
  }

  const ordered = [
    ...txHashes.filter(h => h.symbol === "SVP"),
    ...txHashes.filter(h => h.symbol !== "SVP"),
  ];
  const tried = new Set();

  for (const h of ordered) {
    if (tried.has(h.hash)) continue;
    tried.add(h.hash);
    log(`   ${C.cyan}💧 trying proof tx ${h.hash} (${h.symbol})${C.reset}`);
    try {
      const r = await client.claimTask(task.id, { txHash: h.hash });
      log(`   ${C.green}💧 faucet verified +${r.pointsAwarded} pts${C.reset}`);
      return true;
    } catch (e) {
      const msg = e.message || "";
      if (/not sent to the official faucet contract/i.test(msg)) {
        log(`   ${C.yellow}💧 ${h.symbol} hash rejected (not a faucet tx) — trying next${C.reset}`);
        continue;
      }
      if (/invalid transaction hash/i.test(msg)) {
        log(`   ${C.yellow}💧 ${h.symbol} hash rejected (invalid) — trying next${C.reset}`);
        continue;
      }
      log(`   ${C.yellow}💧 claim with ${h.symbol} hash failed: ${msg}${C.reset}`);
      break;
    }
  }

  log(`   ${C.red}💧 no recovered hash was accepted by the backend${C.reset}`);
  log(`   ${C.yellow}💡 A fresh faucet drip is needed. Try again in ~10 minutes when cooldown expires, or delete faucet_cooldowns.json to force a new drip.${C.reset}`);
  return false;
}

async function handleVerifyThenClaim(client, task) {
  if (task.userStatus === "done") return true;

  if (task.userStatus === "todo") {
    try { await client.startTask(task.id); } catch {}
  }

  let upd;
  try { upd = await client.verifyTask(task.id); }
  catch (e) {
    if (!/PRODUCT_BUSY|PRODUCT_TASK_NOT_SUPPORTED/i.test(e.message)) {
      log(`   ${C.yellow}🔍 verify: ${e.message}${C.reset}`);
    }
    return false;
  }

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
    try {
      const r = await client.claimTask(task.id, {});
      log(`   ${C.green}✅ claim ${task.title} +${r.pointsAwarded}${C.reset}`);
      return true;
    } catch (e) {
      log(`   ${C.yellow}claim ${task.title}: ${e.message}${C.reset}`);
      return false;
    }
  }
  return false;
}

async function handleOnchainTxCount(client, task) {
  if (task.userStatus === "done") return true;
  if (task.userStatus === "todo") {
    try { await client.startTask(task.id); } catch {}
  }
  try {
    const r = await client.claimTask(task.id, {});
    log(`   ${C.green}✅ claim ${task.title} +${r.pointsAwarded}${C.reset}`);
    return true;
  } catch (e) {
    if (/not completed|not ready|threshold|not supported/i.test(e.message)) {
      log(`   ${C.dim}⏭️  ${task.title}: on-chain count not met yet${C.reset}`);
    } else {
      log(`   ${C.yellow}${task.title}: ${e.message}${C.reset}`);
    }
    return false;
  }
}

async function handleGeneric(client, task) {
  if (task.userStatus === "done") return true;
  if (task.userStatus === "todo") {
    await client.startTask(task.id).catch(() => {});
  } else if (task.userStatus === "claimable") {
    const r = await client.claimTask(task.id, {});
    log(`   ${C.green}✅ claim ${task.title} +${r.pointsAwarded}${C.reset}`);
    return true;
  }
  return false;
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
    return true;
  }

  const progress = task.productState?.progress ?? 0;
  const target = task.productState?.target ?? 3;

  if (progress >= target) {
    log(`\n${C.cyan}🔄 ─── swap_check at ${progress}/${target} — verifying ───${C.reset}`);
    return await handleVerifyThenClaim(client, task);
  }

  if (!DO_SWAP) {
    log(`\n${C.cyan}🔄 ─── swap disabled (--no-swap) — verifying only ───${C.reset}`);
    return await handleVerifyThenClaim(client, task);
  }

  log(`\n${C.bold}${C.cyan}🔄 ─── swap_check: executing 3 swap legs ───${C.reset}`);
  let hashes = [];
  try { hashes = await performDistinctSwaps(privateKey, provider); }
  catch (e) { log(`   ${C.red}🔄 swap error: ${e.message}${C.reset}`); }

  if (hashes.length === 0) {
    log(`   ${C.yellow}😕 no swaps landed — verifying anyway${C.reset}`);
    return await handleVerifyThenClaim(client, task);
  }

  TXHASHES.set(address, "swap_last", hashes.join(","));
  log(`   ${C.green}⏳ swaps landed — waiting 90s for indexer…${C.reset}`);
  await sleep(90_000);

  for (let i = 1; i <= MAX_SWAP_POLL_ATTEMPTS; i++) {
    let upd;
    try { upd = await client.verifyTask(task.id); }
    catch (e) {
      if (!/PRODUCT_BUSY/i.test(e.message)) {
        log(`   ${C.yellow}🔍 verify ${i}/${MAX_SWAP_POLL_ATTEMPTS}: ${e.message}${C.reset}`);
      }
    }

    if (upd) {
      const ps = upd.productState;
      log(`   🔍 verify swap_check → ${upd.userStatus}` +
          (ps ? ` (${ps.progress ?? "?"}/${ps.target ?? "?"}` +
                (ps.uniqueDirectionCount != null ? `, dirs=${ps.uniqueDirectionCount}` : "") +
                (ps.reasonCode ? `, reason=${ps.reasonCode}` : "") + `)` : ""));

      if (upd.userStatus === "claimable") {
        const r = await client.claimTask(task.id, {});
        log(`   ${C.green}✅ claim ${task.title} +${r.pointsAwarded}${C.reset}`);
        return true;
      }
      if (upd.userStatus === "done") return true;
    }
    if (i < MAX_SWAP_POLL_ATTEMPTS) await sleep(POLL_INTERVAL_MS);
  }

  log(`   ${C.yellow}😕 swap_check still not claimable after retries${C.reset}`);
  return false;
}

async function handleLendoraTask(client, task, privateKey, provider) {
  if (task.userStatus === "done") {
    log(`\n${C.cyan}🏦 ─── Lendora already done ───${C.reset}`);
    return true;
  }

  const progress = task.productState?.progress ?? 0;
  const target = task.productState?.target ?? 1;

  if (progress < target && DO_LEND) {
    log(`\n${C.bold}${C.green}🏦 ─── Step 5: Lendora supply ───${C.reset}`);
    let hash = null;
    try { hash = await performLendoraSupply(privateKey, provider); }
    catch (e) { log(`   ${C.red}🏦 lendora error: ${e.message}${C.reset}`); }

    if (hash) {
      log(`   ${C.green}⏳ supply landed — waiting 20s for indexer…${C.reset}`);
      await sleep(20_000);
    }
  } else if (progress >= target) {
    log(`\n${C.cyan}🏦 ─── Lendora at ${progress}/${target} — verifying ───${C.reset}`);
  } else {
    log(`\n${C.cyan}🏦 ─── Lendora disabled (--no-lend) ───${C.reset}`);
  }

  for (let i = 1; i <= MAX_LEND_POLL_ATTEMPTS; i++) {
    let upd;
    try { upd = await client.verifyTask(task.id); }
    catch (e) {
      if (!/PRODUCT_BUSY|PRODUCT_TASK_NOT_SUPPORTED/i.test(e.message)) {
        log(`   ${C.yellow}🔍 verify lendora ${i}/${MAX_LEND_POLL_ATTEMPTS}: ${e.message}${C.reset}`);
      }
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const ps = upd?.productState;
    log(`   🔍 verify ${task.title} → ${upd.userStatus}` +
        (ps ? ` (${ps.progress ?? "?"}/${ps.target ?? "?"}` +
              (ps.reasonCode ? `, reason=${ps.reasonCode}` : "") + `)` : ""));

    if (upd.userStatus === "claimable") {
      try {
        const r = await client.claimTask(task.id, {});
        log(`   ${C.green}✅ claim ${task.title} +${r.pointsAwarded}${C.reset}`);
        return true;
      } catch (e) {
        log(`   ${C.yellow}🏦 claim failed: ${e.message}${C.reset}`);
      }
    } else if (upd.userStatus === "done") {
      return true;
    }

    if (i < MAX_LEND_POLL_ATTEMPTS) await sleep(POLL_INTERVAL_MS);
  }

  log(`   ${C.yellow}😕 lending_check still not claimable after ${MAX_LEND_POLL_ATTEMPTS} attempts${C.reset}`);
  return false;
}

async function handleBridgeTask(client, task, address, privateKey, provider) {
  if (task.userStatus === "done") {
    log(`\n${C.cyan}🌉 ─── bridge_check already done ───${C.reset}`);
    return true;
  }

  const progress = task.productState?.progress ?? 0;
  const target = task.productState?.target ?? 1;
  const processing = task.productState?.bridgeSummary?.processingCount ?? 0;

  if (progress >= target) {
    log(`\n${C.cyan}🌉 ─── bridge progress ${progress}/${target} — verifying ───${C.reset}`);
    return await handleVerifyThenClaim(client, task);
  }

  if (processing > 0) {
    log(`\n${C.cyan}🌉 ─── bridge already processing (${processing}) — verifying ───${C.reset}`);
    return await handleVerifyThenClaim(client, task);
  }

  if (!DO_BRIDGE) {
    log(`\n${C.cyan}🌉 ─── bridge disabled (--no-bridge) ───${C.reset}`);
    return false;
  }

  log(`\n${C.bold}${C.blue}🌉 ─── Executing bridge SVP → Arbitrum Sepolia ───${C.reset}`);
  let hash;
  try { hash = await performBridge(privateKey, provider); }
  catch (e) { log(`   ${C.red}🌉 bridge error: ${e.message}${C.reset}`); return false; }

  if (!hash) {
    log(`   ${C.yellow}😕 no bridge tx sent — trying verify anyway${C.reset}`);
    return await handleVerifyThenClaim(client, task);
  }

  TXHASHES.set(address, "bridge_last", hash);
  log(`   ${C.green}⏳ waiting ${BRIDGE_VERIFY_WAIT_MS / 1000}s for indexer…${C.reset}`);
  await sleep(BRIDGE_VERIFY_WAIT_MS);

  for (let i = 1; i <= MAX_BRIDGE_POLL_ATTEMPTS; i++) {
    let upd;
    try { upd = await client.verifyTask(task.id); }
    catch (e) {
      if (!/PRODUCT_BUSY/i.test(e.message)) {
        log(`   ${C.yellow}🔍 verify ${i}/${MAX_BRIDGE_POLL_ATTEMPTS}: ${e.message}${C.reset}`);
      }
    }

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
        return true;
      }
      if (upd.userStatus === "done") return true;
    }
    if (i < MAX_BRIDGE_POLL_ATTEMPTS) await sleep(POLL_INTERVAL_MS);
  }

  log(`   ${C.yellow}😕 bridge_check still not claimable after retries${C.reset}`);
  return false;
}

async function runAccount(account, idx, total, ctx) {
  const { solver, provider } = ctx;

  log(`\n${C.bold}🏦 ═════ [ ${idx + 1}/${total} ] ${account.label} ═════${C.reset}`);

  let conn;
  try { conn = await loginAccount(account.privateKey); }
  catch (e) { log(`${C.red}🔐 LOGIN FAIL: ${e.message}${C.reset}`); return; }

  const { client, address } = conn;
  log(`📍 Address: ${address}`);

  const anyFresh = FAUCET_TOKENS.some(t => FAUCET_COOLDOWNS.isFresh(address, t.address));
  if (!anyFresh) {
    const n = TXHASHES.clearFaucetKeys(address);
    if (n) log(`   ${C.dim}🧹 faucet cooldowns expired — cleared ${n} stale faucet key(s)${C.reset}`);
  }

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

  const getTask = (type) => tasks.find(t => t.actionType === type);
  const isDone = (t) => !t || t.userStatus === "done";

  const faucetTask = getTask("faucet_claim");
  if (faucetTask && faucetTask.userStatus !== "done") {
    log(`\n${C.bold}${C.green}💧 ─── Step 1: Faucet ───${C.reset}`);
    let faucetOk = false;
    try { faucetOk = await handleFaucet(client, faucetTask, address); }
    catch (e) { log(`   ${C.red}💧 faucet error: ${e.message}${C.reset}`); }

    if (provider) {
      const bal = await safeGetBalance(provider, address);
      if (bal != null) log(`   ${C.cyan}💰 Balance after faucet: ${ethers.formatEther(bal)} SVP${C.reset}`);
      else log(`   ${C.yellow}💰 balance check failed (RPC) — continuing${C.reset}`);
    }

    if (!faucetOk) {
      log(`\n${C.yellow}⚠️  Faucet task is not claimable — everything behind it is LOCKED.${C.reset}`);
      log(`${C.yellow}⚠️  Skipping the rest of the daily chain for this account.${C.reset}`);
      return;
    }

    try { tasks = flattenTasks(await client.tasks()); } catch {}
  } else if (faucetTask) {
    log(`\n${C.cyan}💧 ─── Step 1: Faucet skipped (done) ───${C.reset}`);
  }

  const checkinTask = getTask("checkin");
  if (checkinTask && checkinTask.userStatus !== "done") {
    log(`\n${C.bold}${C.green}📅 ─── Step 2: Check-in ───${C.reset}`);
    try { await handleCheckin(client, checkinTask); }
    catch (e) { log(`   ${C.red}📅 checkin error: ${e.message}${C.reset}`); }
    try { tasks = flattenTasks(await client.tasks()); } catch {}
    if (!isDone(getTask("checkin"))) {
      log(`\n${C.yellow}⚠️  Check-in not complete — skipping quiz/swap/lend/bridge.${C.reset}`);
      return;
    }
  } else if (checkinTask) {
    log(`\n${C.cyan}📅 ─── Step 2: Check-in skipped (done) ───${C.reset}`);
  }

  const quizTask = getTask("quiz");
  if (quizTask && quizTask.userStatus !== "done") {
    log(`\n${C.bold}${C.green}🧠 ─── Step 3: Quiz ───${C.reset}`);
    try { await handleQuiz(client, quizTask, solver); }
    catch (e) { log(`   ${C.red}🧠 quiz error: ${e.message}${C.reset}`); }
    try { tasks = flattenTasks(await client.tasks()); } catch {}
    if (!isDone(getTask("quiz"))) {
      log(`\n${C.yellow}⚠️  Quiz not complete — skipping swap/lend/bridge.${C.reset}`);
      return;
    }
  } else if (quizTask) {
    log(`\n${C.cyan}🧠 ─── Step 3: Quiz skipped (done) ───${C.reset}`);
  }

  const swapTask = getTask("swap_check");
  if (swapTask && swapTask.userStatus !== "done") {
    log(`\n${C.bold}${C.green}🔄 ─── Step 4: Auto-Swap ───${C.reset}`);
    try { await handleSwapTask(client, swapTask, address, account.privateKey, provider); }
    catch (e) { log(`   ${C.red}🔄 swap error: ${e.message}${C.reset}`); }
    try { tasks = flattenTasks(await client.tasks()); } catch {}
    if (!isDone(getTask("swap_check"))) {
      log(`\n${C.yellow}⚠️  Swap not complete — skipping lend/bridge.${C.reset}`);
      return;
    }
  } else if (swapTask) {
    log(`\n${C.cyan}🔄 ─── Step 4: Auto-Swap skipped (done) ───${C.reset}`);
  }

  const lendTask = getTask("lending_check");
  if (!DO_LEND) {
    log(`\n${C.cyan}🏦 ─── Step 5: Lendora disabled ───${C.reset}`);
  } else if (!lendTask) {
    log(`\n${C.cyan}🏦 ─── Step 5: no lending_check ───${C.reset}`);
  } else if (lendTask.userStatus === "done") {
    log(`\n${C.cyan}🏦 ─── Step 5: Lendora skipped (done) ───${C.reset}`);
  } else {
    let lendOk = false;
    try { lendOk = await handleLendoraTask(client, lendTask, account.privateKey, provider); }
    catch (e) { log(`   ${C.red}🏦 lendora error: ${e.message}${C.reset}`); }
    try { tasks = flattenTasks(await client.tasks()); } catch {}
    if (!lendOk && !isDone(getTask("lending_check"))) {
      log(`\n${C.yellow}⚠️  Lendora not complete — skipping bridge.${C.reset}`);
      return;
    }
  }

  const bridgeTask = getTask("bridge_check");
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
        case "onchain_tx_count":
          await handleOnchainTxCount(client, t);
          break;
        default:
          await handleGeneric(client, t);
      }
    } catch (e) {
      log(`   ${C.red}❌ ${t.title}: ${e.message}${C.reset}`);
    }
  }
  if (!didAnything) log(`   ${C.dim}(nothing left)${C.reset}`);

  log(`\n${C.bold}${C.green}🎁 ─── Step 8: Region chests ───${C.reset}`);
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

async function preSleepSweep(ctx) {
  const { accounts } = ctx;
  if (accounts.length === 0) return;

  log(`\n${C.cyan}🔁 Pre-sleep sweep — waiting ${PRE_SLEEP_SWEEP_WAIT_MS / 60000} min for slow indexers…${C.reset}`);
  await sleep(PRE_SLEEP_SWEEP_WAIT_MS);

  for (const account of accounts) {
    let conn;
    try { conn = await loginAccount(account.privateKey); }
    catch (e) { log(`   ${C.red}sweep login fail ${account.label}: ${e.message}${C.reset}`); continue; }
    const { client } = conn;

    let tasks = [];
    try { tasks = flattenTasks(await client.tasks()); }
    catch { continue; }

    let changed = false;
    for (const t of tasks) {
      if (t.userStatus === "done") continue;
      if (!["bridge_check", "swap_check", "lending_check", "onchain_tx_count"].includes(t.actionType)) continue;

      try {
        const upd = await client.verifyTask(t.id);
        const ps = upd?.productState;
        log(`   🔍 sweep ${t.actionType} → ${upd.userStatus}` +
            (ps ? ` (${ps.progress ?? "?"}/${ps.target ?? "?"}` +
                  (ps.reasonCode ? `, reason=${ps.reasonCode}` : "") +
                  (ps.bridgeSummary ? `, bridge processing=${ps.bridgeSummary.processingCount ?? 0}` : "") +
                  `)` : ""));
        if (upd.userStatus === "claimable") {
          const r = await client.claimTask(t.id, {});
          log(`   ${C.green}✅ sweep claimed ${t.title} +${r.pointsAwarded}${C.reset}`);
          changed = true;
        }
      } catch (e) {
        if (!/PRODUCT_BUSY|PRODUCT_TASK_NOT_SUPPORTED/i.test(e.message)) {
          log(`   ${C.yellow}sweep ${t.actionType}: ${e.message}${C.reset}`);
        }
      }
      await sleep(3000);
    }

    if (changed) {
      try { await claimAllRegionChests(client); } catch {}
    }
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

  log(`\n${C.dim}🧹 End-of-cycle cleanup — clearing faucet hashes for next run…${C.reset}`);
  for (const acc of accounts) {
    const n = TXHASHES.clearFaucetKeys(acc.address);
    if (n) log(`   ${C.dim}cleared ${n} faucet key(s) for ${acc.address.slice(0, 10)}…${C.reset}`);
  }

  log(`\n${C.green}${C.bold}✅ Cycle #${cycleNum} complete.${C.reset}`);
}

function buildProvider() {
  if (RPC_URLS.length === 1) {
    return new ethers.JsonRpcProvider(RPC_URLS[0], CHAIN_ID, {
      staticNetwork: true,
      timeout: RPC_CALL_TIMEOUT_MS,
    });
  }
  const configs = RPC_URLS.map((url, i) => ({
    provider: new ethers.JsonRpcProvider(url, CHAIN_ID, {
      staticNetwork: true,
      timeout: RPC_CALL_TIMEOUT_MS,
    }),
    priority: i + 1,
    stallTimeout: 4000,
    weight: 1,
  }));
  return new ethers.FallbackProvider(configs, CHAIN_ID, { quorum: 1 });
}

async function showMenu() {
  const rl = readline.createInterface({ input, output });
  console.log("");
  console.log(`${C.cyan}${C.bold}════════════════════════════════════════${C.reset}`);
  console.log(`${C.cyan}${C.bold}  SVP Rewards — connection mode${C.reset}`);
  console.log(`${C.cyan}${C.bold}════════════════════════════════════════${C.reset}`);
  console.log(`  ${C.green}[1]${C.reset} Direct connection (no proxy)`);
  console.log(`  ${C.green}[2]${C.reset} Proxy mode (load from ${PROXY_FILE})`);
  console.log("");
  let answer = "";
  while (!["1", "2"].includes(answer)) {
    answer = (await rl.question(`  Choose [1/2]: `)).trim();
  }
  rl.close();
  console.log("");
  return answer;
}

async function main() {
  if (!SKIP_MENU && !MENU_PROXY) {
    const choice = await showMenu();
    if (choice === "2") {
      PROXY_LIST = loadProxies();
      if (PROXY_LIST.length === 0) {
        console.log(`${C.red}No proxies found in ${PROXY_FILE}. Falling back to direct.${C.reset}`);
        MENU_PROXY_VALUE = "no";
      } else {
        MENU_PROXY_VALUE = "yes";
        console.log(`${C.green}Loaded ${PROXY_LIST.length} proxy(ies) from ${PROXY_FILE}${C.reset}`);
      }
    } else {
      MENU_PROXY_VALUE = "no";
    }
  } else if (MENU_PROXY === "yes") {
    PROXY_LIST = loadProxies();
    MENU_PROXY_VALUE = PROXY_LIST.length > 0 ? "yes" : "no";
  } else {
    MENU_PROXY_VALUE = "no";
  }

  log(`${C.cyan}${C.bold}🌟 SVP Rewards — daily auto-farmer (v5.3)${C.reset}`);
  log(`⛓️  Chain ID  : ${CHAIN_ID}`);
  log(`🌐 RPCs      : ${RPC_URLS.join(", ")}`);
  log(`🔀 Router    : ${ROUTER_ADDRESS}`);
  log(`🌉 Bridge    : ${BRIDGE_CONTRACT}`);
  log(`🌐 Network   : ${MENU_PROXY_VALUE === "yes" ? `PROXY (${PROXY_LIST.length} loaded)` : "DIRECT"}`);
  log(`🧪 Dry run   : ${DRY_RUN ? "YES" : "no"}`);
  log(`🔄 Run mode  : ${RUN_ONCE ? "ONCE" : "LOOP (daily)"}`);
  log(`⏰ Reset UTC : ${RESET_HOUR}:00`);
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

  let provider = null;
  if (DO_LEND || DO_BRIDGE || DO_SWAP) {
    provider = buildProvider();
    try {
      const net = await withTimeout(provider.getNetwork(), RPC_CALL_TIMEOUT_MS, "RPC init");
      if (Number(net.chainId) !== CHAIN_ID) throw new Error(`chainId ${net.chainId}`);
      log(`${C.green}🌐 RPC OK: chainId ${net.chainId}${C.reset}`);
    } catch (e) {
      log(`${C.red}🌐 RPC fail: ${e.message}${C.reset}`);
      log(`${C.yellow}⚠️  Continuing without provider — swap/lend/bridge will be skipped.${C.reset}`);
      provider = null;
    }
  }

  const ctx = { solver, provider, accounts };

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
    try { await preSleepSweep(ctx); }
    catch (e) { log(`${C.red}sweep crashed: ${e.message}${C.reset}`); }
    await sleepUntilNextRun();
  }
}

main().catch((e) => {
  console.error(`${C.red}💀 Fatal: ${e.message}${C.reset}`);
  process.exit(1);
});