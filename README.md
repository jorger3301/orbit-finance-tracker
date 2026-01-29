# 🚀 Orbit Tracker v11.0

Professional Telegram bot for tracking Orbit Finance DLMM pools on Solana.

![Version](https://img.shields.io/badge/version-11.0.0-blue)
![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-green)
![License](https://img.shields.io/badge/license-MIT-brightgreen)

## ✨ Features

### 🌐 Pool Explorer
- **Browse All Pools** - View all Orbit pools with sorting
- **Sort by Volume/TVL/Trades** - Find the most active pools
- **Trending Pools** - Top 10 by 24h volume
- **New Pools** - Recently added pools (last 48h)
- **Pool Search** - Find by name, symbol, or address
- **Pool Details** - Price, volume, TVL, fees, links

### 🔔 Real-time Alerts
- **CIPHER Alerts** - Buy/sell trades and LP events
- **Other Pool Alerts** - Configurable for all pools
- **Whale Tracking** - Monitor specific wallets
- **LP Monitoring** - Add/remove liquidity events
- **Custom Thresholds** - Set minimum alert amounts

### 📈 Portfolio Tracking
- **Multi-Wallet Support** - Track up to 5 wallets
- **Net Worth** - Total value across all holdings
- **PnL Analytics** - Realized & unrealized profit/loss
- **Token Holdings** - All tokens with USD values
- **LP Positions** - Active liquidity positions
- **Staked CIPHER** - sCIPHER balance and value

### 📊 Charts & Analytics
- **OHLCV Charts** - 1h, 4h, 1d, 1w timeframes
- **PnL Leaderboards** - Top traders by profit
- **Liquidity History** - LP event timeline
- **Volume Statistics** - 24h trading data

### ⚙️ User Experience
- **One-tap Setup** - Quick preset configurations
- **Snooze/Quiet Hours** - Pause alerts temporarily
- **Daily Digest** - Summary at 9:00 UTC
- **Watchlists** - Track favorite tokens/pools
- **Alert History** - Recent notifications

## 📱 Commands

| Command | Description |
|---------|-------------|
| `/start` | Open main menu |
| `/menu` | Open main menu |
| `/pools` | Browse all pools |
| `/trending` | Top pools by volume |
| `/newpools` | Recently added pools |
| `/portfolio` | View your portfolio |
| `/pnl` | Quick PnL summary |
| `/lp` | View LP positions |
| `/refresh` | Sync portfolio data |
| `/price` | SOL & CIPHER prices |
| `/cipher` | CIPHER token stats |
| `/chart` | Price chart |
| `/leaderboard` | Top traders PnL |
| `/liquidity` | LP event history |
| `/wallets` | Manage tracked wallets |
| `/settings` | Alert preferences |
| `/pause` | Pause all alerts |
| `/resume` | Resume alerts |
| `/snooze` | Snooze for 1 hour |
| `/stats` | Your usage stats |
| `/status` | Bot & API status |
| `/help` | Show all commands |

## 🚀 Deployment (Fly.io)

### Prerequisites
- [Fly.io account](https://fly.io)
- Telegram Bot Token (from [@BotFather](https://t.me/BotFather))
- Helius API Key (from [helius.dev](https://helius.dev))

### Quick Deploy

```bash
# Install Fly CLI
curl -L https://fly.io/install.sh | sh

# Login
fly auth login

# Clone repo
git clone https://github.com/jorger3301/orbit-finance-tracker.git
cd orbit-finance-tracker

# Create app
fly launch --no-deploy

# Create persistent volume
fly volumes create orbit_data --region sjc --size 1

# Set secrets
fly secrets set TELEGRAM_BOT_TOKEN=your_token HELIUS_API_KEY=your_key

# Deploy
fly deploy
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | ✅ | Bot token from BotFather |
| `HELIUS_API_KEY` | ✅ | Helius RPC API key |
| `DATA_DIR` | ❌ | Data directory (default: `/data`) |
| `DEBUG` | ❌ | Enable debug logs (default: `false`) |

## 📁 Project Structure

```
orbit-tracker/
├── index.js          # Main bot code (8,300+ lines)
├── package.json      # Dependencies
├── Dockerfile        # Container config
├── fly.toml          # Fly.io config
├── .env.example      # Environment template
├── .gitignore        # Git ignore rules
├── .dockerignore     # Docker ignore rules
└── README.md         # Documentation
```

## 🛠️ Tech Stack

- **Runtime:** Node.js 18+
- **Framework:** Telegraf 4.x
- **Database:** SQLite (better-sqlite3)
- **Blockchain:** Solana Web3.js, Helius SDK
- **Charts:** Chart.js + chartjs-node-canvas
- **Deployment:** Fly.io with persistent volumes

## 📊 Stats

- **~8,300 lines** of production code
- **22 commands** registered
- **81 action handlers**
- **130+ try/catch** blocks
- **180+ safe handler** calls

## 🔄 Updates

### v11.0.0 (Latest)
- 🌐 Pool Explorer with sorting & search
- 🔥 Trending pools feature
- 🆕 New pools discovery
- ⚙️ Other pools settings panel
- 🔧 Multi-wallet save fix
- 💰 Staked CIPHER price fix
- 📱 Updated help & welcome

### v10.9.0
- Initial Fly.io deployment
- Portfolio multi-wallet support
- Staked CIPHER tracking

## 📄 License

MIT License - feel free to use and modify.

## 🔗 Links

- **Bot:** [@OrbitFinanceTrackerBot](https://t.me/OrbitFinanceTrackerBot)
- **Orbit Markets:** [markets.cipherlabsx.com](https://markets.cipherlabsx.com)
- **GitHub:** [jorger3301/orbit-finance-tracker](https://github.com/jorger3301/orbit-finance-tracker)

---

Made with ❤️ for the Orbit Finance community
