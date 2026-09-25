# SvpChain Daily Farmer 🚀

An advanced **Node.js automation bot** for SVP Chain rewards farming. Fully automates faucet claims, daily tasks, quizzes, swaps, lending, and cross-chain bridging.

**Repository:** [SvpChain_Daily](https://github.com/mejri02/SvpChain_Daily)  
**Community:** [AirDropXDevs Telegram](https://t.me/AirDropXDevs)  
**Rewards Portal:** [rewards.svpstars.com](https://rewards.svpstars.com/?invite=7P1O4PCS)

---

## 🌟 Features

✅ **Faucet Claiming** – Automated multi-token drips with ALTCHA CAPTCHA solving  
✅ **Quiz Automation** – AI-powered quiz solving via Groq API  
✅ **Daily Check-ins** – Auto-claim daily rewards  
✅ **Token Swaps** – Execute 3-leg swap sequences (WSVP → USDC, WETH, WBTC)  
✅ **Lending** – Auto-supply tokens to Lendora  
✅ **Cross-Chain Bridge** – Bridge SVP to Arbitrum Sepolia  
✅ **Multi-Account** – Run hundreds of accounts with cooldowns  
✅ **Proxy Support** – HTTP & SOCKS5 proxies for account isolation  
✅ **Task Verification** – Auto-verify and claim all task types  
✅ **Dry Run Mode** – Test without executing transactions  

---

## 📋 Prerequisites

- **Node.js** ≥ 18.x (LTS recommended)
- **npm** 9.x+
- Active wallet(s) on SVP Chain
- Small SVP balance for gas (0.01–0.1 SVP per account recommended)

---

## 🔧 Installation

### 1. Clone & Setup

```bash
git clone https://github.com/mejri02/SvpChain_Daily.git
cd SvpChain_Daily
npm install
```

### 2. Create Configuration Files

#### **accounts.json** – Your Wallets

```json
[
  {
    "label": "Account #1",
    "address": "0x1234567890abcdef1234567890abcdef12345678",
    "privateKey": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
  },
  {
    "label": "Account #2",
    "address": "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    "privateKey": "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd"
  }
]
```

> ⚠️ **NEVER commit this file!** Keep it in `.gitignore`. Use **0x-prefixed** hex private keys.

#### **groq.txt** – Groq API Key (Optional)

```
gsk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Get a free Groq API key from [console.groq.com](https://console.groq.com) to enable AI quiz solving. Without this, quizzes will be skipped.

#### **proxy.txt** – Proxy List (Optional)

```
http://user:pass@proxy1.com:8080
http://user:pass@proxy2.com:8080
socks5://user:pass@proxy3.com:1080
```

One proxy per line. Supports HTTP and SOCKS5. If omitted, bot runs without proxies.

---

## 🛠️ ALTCHA Setup (Faucet CAPTCHA Solver)

### What is ALTCHA?

**ALTCHA** is a proof-of-work CAPTCHA used by the SVP Chain faucet. The bot solves it **automatically** using the `altcha` npm library, which performs CPU-intensive key derivation (`pbkdf2`) until a valid solution is found.

### How It Works

1. **Bot requests CAPTCHA challenge** from `https://www.svpchain.org/api/altcha/challenge`
2. **Challenge contains:**
   - A random number (`salt`)
   - Difficulty level (`complexity`)
   - Hashing algorithm (`algorithm` — SHA256)
3. **Bot solves** the challenge by:
   - Incrementing a counter
   - Computing `PBKDF2(password + counter, salt, iterations, algorithm)`
   - Finding a counter where result < target difficulty
4. **Solution submitted** to faucet endpoint with proof-of-work proof
5. **Faucet verifies** the solution and sends tokens

### Automatic Setup

The bot handles **all ALTCHA solving automatically**. No manual configuration needed!

**Key constants in `index.js`:**

```javascript
const ALTCHA_BASE = "https://www.svpchain.org/api/altcha/challenge";
const ALTCHA_SOLVE_TIMEOUT_MS = 45_000;  // 45 second timeout
const MAX_ALTCHA_ATTEMPTS = 3;            // Retry up to 3 times
const INTER_TOKEN_DELAY = 60_000;         // 60s between token claims
```

### Understanding ALTCHA Solving

The solver works like this:

```javascript
// 1. Request challenge
const envelope = await fetchAltchaEnvelope(address, tokenAddress);
// → { parameters: "...", signature: "..." }

// 2. Solve challenge via proof-of-work
const solution = await solveChallenge({
  challenge: envelope,
  deriveKey: pbkdf2.deriveKey,
  timeout: 45_000,
});
// → { counter: 12345, derivedKey: "abc...", time: 2500 }

// 3. Encode solution as token
const altchaToken = buildAltchaToken(envelope, solution);

// 4. Submit to faucet
const response = await httpJson("POST", FAUCET_ENDPOINT, {
  body: JSON.stringify({
    chain: "svp-testnet",
    token: tokenAddress,
    address,
    altcha: altchaToken,  // Proof-of-work token
  }),
});
```

### Troubleshooting ALTCHA

| Issue | Cause | Fix |
|-------|-------|-----|
| `altcha gave up after 45000ms` | Solver timeout | Increase `ALTCHA_SOLVE_TIMEOUT_MS` |
| `challenge HTTP 429` | Rate limited | Wait 5 min before next faucet claim |
| `challenge HTTP 500` | Server error | Retry (bot retries automatically 3x) |
| `altcha: timeout` | Slow CPU or network | Consider increasing `MAX_ALTCHA_ATTEMPTS` |

**To increase timeout:**
```javascript
const ALTCHA_SOLVE_TIMEOUT_MS = 60_000;  // 60 seconds instead of 45
```

---

## 🚀 Usage

### Run Once (Test Mode)

```bash
node index.js --once --dry
```

- `--dry` = test without executing any transactions
- `--once` = run 1 cycle and exit (don't loop)

### Run with Full Automation

```bash
node index.js
```

Runs daily cycle at **00:00 UTC** (reset time). Adjust with:

```bash
node index.js --reset-hour 18  # Reset at 18:00 UTC
```

### Run Specific Wallet

```bash
node index.js --only 0x1234567890abcdef...
```

Only processes wallet matching that address.

### Disable Specific Actions

```bash
node index.js --no-swap      # Skip swaps (save gas)
node index.js --no-lend      # Skip Lendora
node index.js --no-bridge    # Skip Arbitrum bridge
node index.js --no-swap --no-bridge  # Combine multiple
```

### Advanced Examples

```bash
# Dry run single wallet for 1 day
node index.js --only 0xabc... --once --dry

# Production run with all features, 9 AM UTC reset
node index.js --reset-hour 9

# Test swaps without bridge/lending
node index.js --once --no-lend --no-bridge

# Run once, show all tasks (useful for debugging)
node index.js --once --dry
```

---

## ⚙️ Configuration

### Environment Variables

```bash
export RPC_URL="https://svp-dataseed1-testnet.svpchain.org"
export CHAIN_ID=2517
export GROQ_MODEL="openai/gpt-oss-120b"
export GROQ_FALLBACK="openai/gpt-oss-20b"
export INVITE_CODE="7P1O4PCS"  # Referral code for rewards
export SLIPPAGE_PERCENT=20     # Swap slippage tolerance (%)
export SWAP_SVP_PER_LEG=0.008  # SVP per swap leg
export BRIDGE_MIN_SVP=0.1      # Min SVP to bridge
export BRIDGE_MAX_SVP=0.15     # Max SVP to bridge
export LENDORA_MAX_SUPPLY=10   # Max tokens to lend

node index.js
```

### Key Configuration (in `index.js`)

| Setting | Value | Purpose |
|---------|-------|---------|
| `CHAIN_ID` | `2517` | SVP Chain testnet |
| `RPC_URL` | `https://svp-dataseed1-testnet.svpchain.org` | RPC endpoint |
| `FAUCET_TOKENS` | `[SVP, USDV, USDC, WBTC, WBNB]` | Tokens to claim |
| `FAUCET_COOLDOWN_MS` | `86400000` | 24h cooldown per token |
| `INTER_TOKEN_DELAY` | `60000` | 60s between token claims |
| `COOLDOWN_BETWEEN_ACCOUNTS` | `30000` | 30s between accounts |
| `SWAP_SLIPPAGE_PCT` | `20` | Max 20% price impact |
| `BRIDGE_DEST_CHAIN_ID` | `421614` | Arbitrum Sepolia |

---

## 📊 Task Types & Automation

The bot auto-handles these tasks:

| Task | Automated | Details |
|------|-----------|---------|
| **Faucet Claim** | ✅ Yes | Multi-token drips with ALTCHA solver |
| **Daily Check-in** | ✅ Yes | +10 pts per day |
| **Quiz** | ✅ Yes | AI-solved via Groq API |
| **Swap Check** | ✅ Yes | 3 swap legs (verify + claim) |
| **Lending Check** | ✅ Yes | Supply to Lendora (verify + claim) |
| **Bridge Check** | ✅ Yes | Bridge SVP to Arbitrum (verify + claim) |
| **Region Chests** | ✅ Yes | Claim newbie/daily/weekly/special |
| **Other Tasks** | ✅ Partial | Most others auto-start/claim |

Skipped tasks (social):
- `bind_x` (X/Twitter binding)
- `x_follow` (Follow X)
- `tg_join` (Join Telegram)
- `discord_join` (Join Discord)
- `tweet` (Post tweets)
- `contract_deploy` (Deploy contracts)

---

## 📁 File Reference

```
SvpChain_Daily/
├── index.js               # Main bot logic
├── package.json           # Dependencies
├── README.md              # This file
├── accounts.json          # YOUR WALLETS (create this)
├── groq.txt               # YOUR GROQ API KEY (optional)
├── proxy.txt              # YOUR PROXIES (optional)
├── txhashes.json          # Auto-generated: transaction logs
├── faucet_cooldowns.json  # Auto-generated: faucet timers
└── .gitignore             # Should include: accounts.json, groq.txt, proxy.txt
```

### Generated Files

- **txhashes.json** – Stores transaction hashes for verification
- **faucet_cooldowns.json** – Tracks 24h faucet cooldowns per wallet

Both auto-created; don't edit manually.

---

## 🔐 Security Best Practices

⚠️ **CRITICAL SAFETY TIPS:**

1. **NEVER share your `accounts.json`** – It contains private keys
2. **NEVER commit to GitHub** – Add to `.gitignore`:
   ```
   accounts.json
   groq.txt
   proxy.txt
   txhashes.json
   faucet_cooldowns.json
   ```
3. **Use testnet only** – Deploy on SVP Chain testnet first
4. **Test with small accounts** – Verify before running production
5. **Rotate proxies** – One proxy per account if possible
6. **Monitor gas prices** – Adjust `SLIPPAGE_PERCENT` if needed

### .gitignore Template

```bash
# Sensitive files
accounts.json
groq.txt
proxy.txt
node_modules/
.env
.DS_Store
*.log

# Generated during runtime
txhashes.json
faucet_cooldowns.json
```

---

## 🐛 Debugging & Logs

### Log Output Example

```
[2024-01-15 10:23:45] ═════ [ 1/2 ] Account #1 ═════
[2024-01-15 10:23:46] 👛 Address: 0x1234567890...
[2024-01-15 10:23:47] 📊 Profile: points=1250 invites=3 rank=#42
[2024-01-15 10:23:48] 📦 Fetched 18 tasks
[2024-01-15 10:24:00] ─── 🚰 Step 1: Faucet ───
[2024-01-15 10:24:05]    📦 ALTCHA solved (counter=8372, 2145ms)
[2024-01-15 10:24:08] ✅ faucet SVP: https://explorer.svpchain.com/tx/0xabc...
[2024-01-15 10:24:09]    ⏳ waiting 60s before next token…
```

### Enable Extra Logging

Edit `index.js` to add debug logs:

```javascript
const DEBUG = true;
if (DEBUG) log(`[DEBUG] envelope:`, envelope);
```

### Common Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `accounts.json missing or empty` | No wallet config | Create `accounts.json` with wallets |
| `INVALID_PRIVATE_KEY` | Bad key format | Use full `0x`-prefixed 64-char hex |
| `API HTTP 401` | Bad Groq key | Check `groq.txt` format: `gsk_...` |
| `challenge HTTP 429` | Rate limited | Wait before next faucet claim |
| `No RPC provider` | Network issue | Check `RPC_URL` and internet |

---

## 💰 Estimated Earnings

Assuming **daily completion**:

| Action | Points | Frequency |
|--------|--------|-----------|
| Check-in | 10 | Daily |
| Quiz | 25–50 | Daily |
| Faucet (SVP) | 5 | Daily |
| Faucet (other tokens) | 5 | Daily |
| Swap (3 legs) | 50 | Daily (if done) |
| Lending | 30 | Daily (if done) |
| Bridge | 40 | Daily (if done) |
| Region chests | 50–100 | Daily |
| **Total** | **~215–340 pts** | **Per account/day** |

> Points → SVP conversion varies. Check rewards portal for current rates.

---

## 📚 API References

### SVP Rewards API
- Endpoint: `https://rewards.svpstars.com/api/v1`
- Auth: JWT Bearer token (auto-generated via signature)
- Endpoints:
  - `GET /auth/nonce?address=...` – Get signing nonce
  - `POST /auth/login` – Sign & get JWT token
  - `GET /me` – Current profile/points
  - `GET /tasks` – All tasks
  - `POST /tasks/{id}/start` – Start task
  - `POST /tasks/{id}/claim` – Claim task
  - `GET /quiz/today` – Today's quiz

### SVP Chain RPC
- **Testnet RPC:** `https://svp-dataseed1-testnet.svpchain.org`
- **Chain ID:** `2517`
- **Explorer:** `https://explorer.svpchain.com`
- **Faucet API:** `https://www.svpchain.org/api/claim`
- **ALTCHA:** `https://www.svpchain.org/api/altcha/challenge`

### Bridge API
- **Base:** `https://pre-bridge.svpstars.com/api`
- Endpoints:
  - `GET /bridge/transactions/address/{addr}` – Check sent txs
  - `GET /deposits/address/{addr}` – Check received deposits

---

## 🤝 Contributing

Found a bug or have a feature request?

1. Check [GitHub Issues](https://github.com/mejri02/SvpChain_Daily/issues)
2. Open a new issue with details
3. Join the [Telegram community](https://t.me/AirDropXDevs) for discussions

---

## 📝 License

This project is open-source. Use at your own risk.

---

## 🙌 Acknowledgments

- **SVP Chain** – For the testnet and rewards program
- **Groq** – For free LLM API access
- **Altcha** – For the open-source CAPTCHA solver
- **ethers.js** – For blockchain interactions

---

## 📞 Support

- **Telegram:** [AirDropXDevs](https://t.me/AirDropXDevs)
- **Rewards Portal:** [rewards.svpstars.com](https://rewards.svpstars.com/?invite=7P1O4PCS)
- **GitHub Issues:** [SvpChain_Daily/issues](https://github.com/mejri02/SvpChain_Daily/issues)

---

**Happy farming! 🚀** Remember to start with the `--dry` and `--once` flags to test your setup first.
