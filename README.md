# 🚀 Orbit Tracker v10.9

**Professional Telegram bot for tracking Orbit Finance DLMM pools on Solana**

[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)
[![Telegram](https://img.shields.io/badge/Telegram-Bot-blue.svg)](https://core.telegram.org/bots)
[![Solana](https://img.shields.io/badge/Solana-Mainnet-purple.svg)](https://solana.com/)
[![Deploy](https://img.shields.io/badge/Deploy-Fly.io-8B5CF6.svg)](https://fly.io)

---

## ✨ Features

### 📊 Real-Time Trading Alerts
- 🔷 **CIPHER token** buy/sell alerts with customizable thresholds
- 🌐 **All Orbit DLMM pools** monitoring
- 🐋 **Whale tracking** — follow specific wallets
- 📏 **Size indicators** (Tiny → Whale 🐋)
- ✅ **Anchor discriminator detection** for accurate TX classification

### 💧 Liquidity Monitoring
- 📢 **LP add/remove alerts** with USD values
- 📜 **Liquidity history** tracking per pool
- ⚡ **Real-time WebSocket** updates

### 📈 Analytics & Charts
- 🏆 **PnL Leaderboards** — Top traders by profit
- 📊 **OHLCV Price Charts** — 15m, 1h, 4h, 1d timeframes
- 📉 **Volume tracking** — 24h stats per pool

### 👛 Portfolio Management
- 💼 **Multi-wallet support** (up to 5 wallets)
- 💎 **Net worth tracking** across all holdings
- 💧 **LP position detection**
- 📊 **PnL calculations**

### ⚙️ User Customization
- 🔔 **Toggle alerts** — CIPHER, other pools, LP events
- 💰 **Threshold settings** — minimum USD for alerts
- 🔕 **Snooze/pause** — take breaks from alerts
- 🌙 **Quiet hours** — schedule alert-free times

---

## 📱 Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome & onboarding |
| `/menu` | Main menu with buttons |
| `/price` | SOL & CIPHER prices |
| `/cipher` | CIPHER token stats |
| `/chart` | Price chart (e.g. `/chart CIPHER 1h`) |
| `/leaderboard` | Top traders by PnL |
| `/liquidity` | LP event history |
| `/portfolio` | Your portfolio overview |
| `/pnl` | Quick PnL summary |
| `/lp` | Your LP positions |
| `/refresh` | Sync portfolio data |
| `/wallets` | Manage tracked wallets |
| `/settings` | Alert preferences |
| `/pause` | Pause all alerts |
| `/resume` | Resume alerts |
| `/snooze` | Snooze for 1 hour |
| `/stats` | Your usage statistics |
| `/status` | Bot & API health |
| `/help` | All commands |

---

## 🚀 Deploy on Fly.io

### Prerequisites

1. **Telegram Bot Token** from [@BotFather](https://t.me/BotFather)
2. **Helius API Key** from [helius.dev](https://helius.dev)
3. **Fly.io Account** at [fly.io](https://fly.io)

### Step 1: Install Fly CLI

```bash
# macOS
brew install flyctl

# Windows
powershell -Command "iwr https://fly.io/install.ps1 -useb | iex"

# Linux
curl -L https://fly.io/install.sh | sh
```

### Step 2: Login to Fly.io

```bash
fly auth login
```

### Step 3: Clone/Create Your Repo

```bash
# Create new directory
mkdir orbit-tracker && cd orbit-tracker

# Copy all files from zip into this directory
# Then initialize git
git init
git add -A
git commit -m "Initial commit"
```

### Step 4: Launch on Fly.io

```bash
# Launch the app (creates fly.toml if needed)
fly launch --no-deploy

# When prompted:
# - App name: orbit-tracker (or your preferred name)
# - Region: sjc (San Jose) or closest to you
# - Don't setup Postgres
# - Don't setup Redis
```

### Step 5: Create Persistent Volume

```bash
# Create 1GB volume for SQLite database
fly volumes create orbit_data --region sjc --size 1
```

### Step 6: Set Secrets

```bash
# Set your API keys (replace with your actual values)
fly secrets set TELEGRAM_BOT_TOKEN=your_bot_token_here
fly secrets set HELIUS_API_KEY=your_helius_key_here
```

### Step 7: Deploy

```bash
fly deploy
```

### Step 8: Monitor Logs

```bash
# Watch logs in real-time
fly logs

# You should see:
# ✅ Helius SDK initialized
# ✅ Database initialized
# ✅ Orbit WS connected
# 🏥 Health server listening on port 8080
# 🚀 ORBIT TRACKER v10.9 (Production)
```

### Step 9: Test Your Bot

Message your bot on Telegram:
```
/start
/price
/status
```

---

## 📁 Project Structure

```
orbit-tracker/
├── index.js          # Main bot (7,795 lines)
├── package.json      # Dependencies
├── Dockerfile        # Docker build config
├── fly.toml          # Fly.io configuration
├── .dockerignore     # Docker build ignores
├── .env.example      # Environment template
├── .gitignore        # Git ignores
└── /data/            # Persistent volume (created by Fly.io)
    └── orbit-tracker.db
```

---

## 🔧 Fly.io Management Commands

```bash
# Check app status
fly status

# View logs
fly logs

# SSH into container
fly ssh console

# Scale resources
fly scale memory 512

# Restart app
fly apps restart

# Open dashboard
fly dashboard
```

---

## 💰 Fly.io Pricing

| Resource | Free Allowance | Cost After |
|----------|---------------|------------|
| **Shared CPU** | 3 shared CPUs | ~$2/mo |
| **Memory** | 256MB | $0.03/GB/mo |
| **Storage** | 3GB volumes | $0.15/GB/mo |
| **Bandwidth** | 100GB | $0.02/GB |

**Estimated Monthly Cost:** $0-5/mo for this bot

---

## 🛡️ Features & Reliability

| Feature | Implementation |
|---------|----------------|
| **Always-On** | `auto_stop_machines = false` |
| **Persistent Data** | Volume mount at `/data` |
| **Health Checks** | HTTP endpoint on port 8080 |
| **Auto-Recovery** | Fly.io automatic restarts |
| **WebSocket Reconnect** | Built-in with 15s delay |
| **Multi-Source Prices** | Jupiter → DexScreener → Birdeye |

---

## 📊 Code Statistics

| Metric | Value |
|--------|-------|
| **Total Lines** | 7,795 |
| **Functions** | 115+ |
| **Commands** | 19 |
| **Button Actions** | 74 |
| **API Integrations** | 5+ |

---

## 🔗 Links

- **Orbit Finance**: [markets.cipherlabsx.com](https://markets.cipherlabsx.com)
- **Fly.io Docs**: [fly.io/docs](https://fly.io/docs)
- **Helius**: [helius.dev](https://helius.dev)

---

## 📄 License

MIT License

---

<p align="center">
  <b>Built with ❤️ for the Orbit Finance community</b>
</p>
