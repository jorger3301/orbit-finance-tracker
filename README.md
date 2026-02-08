# Orbit Tracker v11.0

Professional Telegram bot for tracking Orbit Finance DLMM pools on Solana.

![Version](https://img.shields.io/badge/version-11.0.0-blue)
![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-green)
![License](https://img.shields.io/badge/license-MIT-brightgreen)

## Features

### Pool Explorer
- **Browse All Pools** - Paginated pool list with sorting by volume, TVL, or trades
- **Trending Pools** - Top pools ranked by 24h volume
- **New Pools** - Recently initialized pools (last 48h) with alerts
- **Pool Search** - Find by name, symbol, or mint address
- **Pool Details** - Price, volume, TVL, fees, and DexScreener links
- **Watchlists** - Track favorite pools with quick-access buttons

### Real-time Alerts
- **CIPHER Alerts** - Buy/sell trades and LP add/remove events
- **Other Pool Alerts** - Configurable alerts for all tracked pools
- **Wallet Tracking** - Monitor up to 5 wallets for on-chain activity
- **Whale Monitoring** - Track large wallet movements with custom thresholds
- **Lock/Unlock Alerts** - Liquidity locking and unlocking events
- **Reward Claim Alerts** - Staking reward claim notifications
- **Protocol Fee Alerts** - Fee distribution events
- **Admin Alerts** - Governance and admin action notifications
- **New Pool Alerts** - Notification when new pools are initialized

### Portfolio Tracking
- **Multi-Wallet Support** - Track up to 5 Solana wallets
- **Net Worth** - Total value across all holdings in USD
- **PnL Analytics** - Realized and unrealized profit/loss
- **Token Holdings** - All tokens with live USD values
- **LP Positions** - Active liquidity positions with details
- **Staked CIPHER** - sCIPHER balance and value
- **Trade History** - Full swap history with PnL per trade

### Charts & Analytics
- **OHLCV Charts** - Candlestick + volume charts (15m, 1h, 4h, 1d timeframes)
- **DexScreener Integration** - Direct chart links on all chart views and pool pages
- **PnL Leaderboards** - Top traders ranked by profit
- **Liquidity History** - LP event timeline per pool
- **Volume Statistics** - 24h trading data and trends

### User Experience
- **One-tap Presets** - Quick setup configurations for new users
- **18 Toggle Settings** - Granular control over every alert type
- **Snooze** - Pause alerts for a custom duration
- **Quiet Hours** - Mute alerts during specified time ranges
- **Daily Digest** - Portfolio and activity summary delivered daily
- **Alert History** - View recent notifications
- **Custom Thresholds** - Set minimum USD amounts for alerts

## Commands

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

## Deployment (Fly.io)

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
| `TELEGRAM_BOT_TOKEN` | Yes | Bot token from BotFather |
| `HELIUS_API_KEY` | Yes | Helius RPC API key |
| `DATA_DIR` | No | Data directory (default: `/data`) |
| `DEBUG` | No | Enable debug logs (default: `false`) |

## Architecture

```
orbit-finance-tracker/
├── index.js          # Main bot (~9,100 lines)
├── package.json      # Dependencies
├── Dockerfile        # Container config
├── fly.toml          # Fly.io config
├── .env.example      # Environment template
├── .gitignore        # Git ignore rules
├── .dockerignore     # Docker ignore rules
└── README.md         # Documentation
```

### Transaction Detection
5-method cascade for classifying Solana transactions:
1. Explicit field matching
2. Anchor instruction discriminators (`sha256("global:<name>")[0..8]`)
3. Anchor event log parsing (`sha256("event:<name>")[0..8]`)
4. Heuristic analysis
5. Trade field detection

### 15 Transaction Types
`SWAP` · `LP_ADD` · `LP_REMOVE` · `CLOSE_POSITION` · `LOCK_LIQUIDITY` · `UNLOCK_LIQUIDITY` · `POOL_INIT` · `FEES_DISTRIBUTED` · `CLAIM_REWARDS` · `SYNC_STAKE` · `CLOSE_POOL` · `PROTOCOL_FEES` · `ADMIN` · `SETUP` · `UNKNOWN`

### Reliability
- **Graceful shutdown** - 10s timeout with signal handling (SIGINT/SIGTERM), clears all intervals/cron jobs, closes WebSocket connections, saves state
- **Rate limit handling** - 429 retry logic across all 9 broadcast functions with batched sends (20/batch, 100ms delay)
- **Health monitoring** - TCP health check endpoint with auto-degradation after 3+ API failures
- **Price fallback cascade** - Jupiter → DexScreener → Birdeye → CoinGecko
- **Blocked user handling** - Catches 403 errors during broadcasts, filters deactivated users
- **WAL mode SQLite** - Concurrent reads with crash-safe writes via better-sqlite3

## Tech Stack

- **Runtime:** Node.js 18+
- **Framework:** Telegraf 4.x
- **Database:** SQLite (better-sqlite3, WAL mode)
- **Blockchain:** Solana Web3.js, Helius SDK
- **Charts:** Chart.js + chartjs-node-canvas
- **Scheduling:** node-cron
- **Deployment:** Docker on Fly.io with persistent volumes

## Stats

- **~9,100 lines** of production code
- **22 commands** registered
- **40 action handlers** (inline buttons)
- **9 broadcast functions** for real-time alerts
- **15 transaction types** detected
- **18 user-configurable toggles**
- **151 try/catch blocks**

## License

MIT License - see [LICENSE](LICENSE) for details.

## Links

- **Bot:** [@OrbitFinanceTrackerBot](https://t.me/OrbitFinanceTrackerBot)
- **Orbit Markets:** [markets.cipherlabsx.com](https://markets.cipherlabsx.com)
- **GitHub:** [jorger3301/orbit-finance-tracker](https://github.com/jorger3301/orbit-finance-tracker)

---

Made with care for the Cipher community
