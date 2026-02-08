# CLAUDE.md - Orbit Tracker v11.0

## Project Overview

**Orbit Tracker** is a production-grade Telegram bot for the Solana ecosystem, built for the **Orbit Finance DLMM** (Discretized Liquidity Market Maker) protocol. It provides real-time trade alerts, portfolio tracking, LP monitoring, whale tracking, PnL leaderboards, and OHLCV charts.

- **Author:** CipherLabs
- **License:** MIT
- **Runtime:** Node.js 18+
- **Architecture:** Monolithic single-file (`index.js`, ~8,300 lines)
- **Database:** SQLite (better-sqlite3, WAL mode)
- **Deployment:** Docker on Fly.io (persistent volume at `/data`)
- **Bot Framework:** Telegraf 4.15.0

## Quick Start

```bash
# Install dependencies
npm install

# Run in development mode (DEBUG=true)
npm run dev

# Run in production
npm start

# Syntax check
npm run lint
```

## Environment Variables

**Required:**
- `TELEGRAM_BOT_TOKEN` - Bot API token from @BotFather
- `HELIUS_API_KEY` - Helius RPC API key from helius.dev

**Optional (with defaults):**
- `ORBIT_API` - Orbit Finance API base URL (default: `https://orbit-dex.api.cipherlabsx.com/api/v1`)
- `DATA_DIR` - SQLite data directory (default: `/data`)
- `DEBUG` - Enable debug logging (default: `false`)
- `POOL_REFRESH_INTERVAL` - Pool refresh ms (default: `300000`)
- `PRICE_REFRESH_INTERVAL` - Price refresh ms (default: `300000`)
- `TRADES_POLL_INTERVAL` - Trade poll fallback ms (default: `60000`)
- `MAX_WALLETS_PER_USER` - Max tracked wallets per user (default: `10`)
- `MAX_RECENT_ALERTS` - Max stored alerts per user (default: `10`)
- `MAX_CACHE_SIZE` - Cache size limit (default: `1000`)
- `DAILY_DIGEST_HOUR` / `DAILY_DIGEST_MINUTE` - UTC time for daily digest (default: `9:00`)
- `BIRDEYE_API_KEY` - Optional Birdeye API key for enhanced token data

## File Structure

```
orbit-finance-tracker/
  index.js            # All bot code (~8,300 lines, organized by section)
  package.json        # npm dependencies and scripts
  Dockerfile          # Production container (node:18-alpine + canvas deps)
  fly.toml            # Fly.io deployment config (sjc region, 512MB)
  .env.example        # Environment variable template
  README.md           # User-facing documentation
  LICENSE             # MIT License
```

## Code Architecture (index.js sections)

The monolithic file is organized into clearly separated sections with `═══` dividers:

| Section | Lines (approx) | Purpose |
|---|---|---|
| Config & Logging | 13-106 | Environment config via `CONFIG` object, log utility |
| Solana SDK Init | 109-237 | Helius SDK, Solana Connection, backup RPC |
| API Helpers & Constants | 222-371 | Orbit program ID, Anchor discriminators, fetch helpers |
| Utility Functions | 597-907 | Formatting, validation, date helpers, `fetchWithRetry` |
| Data Access Layer | 1285-1905 | Cache maps, user state management |
| Database Layer | 1329-1779 | SQLite schema (6 tables), migrations, CRUD |
| Blockchain Sync | 2006-4286 | Pool fetching, price oracle, portfolio sync, PnL calc |
| Alert & Notification | 4042-4200 | Trade/LP/whale alert broadcasting with filtering |
| Chart Generation | ~4300-4600 | OHLCV, candlestick, and portfolio pie charts |
| Telegram Handlers | 5639-7515 | 22 commands, 81+ inline button actions |
| Bot Initialization | 8000-8234 | WebSocket setup, cron jobs, graceful shutdown |

## Database Schema (SQLite)

6 tables with foreign keys and indexes:

- **users** - User preferences, settings, stats (JSON), portfolio (JSON)
- **watchlist** - User's watched pools (chat_id + pool_id)
- **tracked_tokens** - User's tracked token mints
- **whale_wallets** - User's tracked wallets with labels
- **portfolio_wallets** - User's portfolio wallets (multi-wallet support)
- **recent_alerts** - Alert history for deduplication and review

## External API Integrations

**Primary (keyed):**
- **Orbit Finance API** (`orbit-dex.api.cipherlabsx.com/api/v1`) - Pools, trades, candles, volumes, WebSocket events
- **Helius** - Enhanced Solana RPC, wallet transaction monitoring via WebSocket

**Backup (free, no keys):**
- **Jupiter** - Token prices and metadata (`price.jup.ag`, `token.jup.ag`)
- **DexScreener** - Price/volume fallback
- **CoinGecko** - Price data fallback
- **Birdeye** - Token security, top traders, wallet analysis (optional key)
- **Solscan** - Transaction lookup, token metadata

**On-chain (Solana RPC):**
- **Orbit Finance Program** (`Fn3fA3fjsmpULNL7E9U79jKTe1KHxPtQeWdURCbJXCnM`) - DLMM pool detection via instruction discriminators
- **Streamflow Staking** (`STAKEvGqQTtzJZH6BWDcbpzXXn2BBerPAgQ3EGLN2GH`) - Staked CIPHER tracking

## Real-Time System

Two concurrent WebSocket connections:

1. **Orbit WS** - Subscribes to all pool trade/LP events via `/ws-ticket` auth
2. **Helius WS** - Subscribes to user-tracked wallets via `logsSubscribe`

Transaction detection uses **Anchor discriminators** (8-byte instruction signatures):
- Swap: `[43, 4, 237, 11, 26, 201, 30, 98]`
- Add Liquidity: `[126, 118, 210, 37, 80, 190, 19, 105]`
- Withdraw: `[242, 80, 163, 0, 196, 221, 194, 194]`

Fallback: heuristic detection when discriminators don't match.

## Key Patterns

### Safety & Reliability
- **130+ try-catch blocks** with graceful fallbacks
- **`safeAnswer(ctx)`** wrapper on all Telegram callback handlers
- **Transaction deduplication** via `seenTxs` Set (last 2,500 txs)
- **Rate limiting** with `p-queue` for all external API calls
- **Retry logic** with `p-retry` (exponential backoff, 3 retries)
- **Graceful shutdown** - saves all data on SIGTERM/SIGINT

### Caching Strategy
- `priceCache` - 30 min TTL
- `tokenOverviewCache` - 1 hour TTL
- `userStakeCache` - 30 min TTL
- `balanceCache` - Dynamic TTL
- `seenTxs` - Rolling window of 2,500 transactions
- `poolMap` - In-memory pool index (Map)
- `users` - In-memory user cache (Map)

### Scheduled Jobs (node-cron)
- Daily digest: 9:00 AM UTC (configurable)
- Weekly stats: Sunday midnight UTC
- Database optimization (VACUUM): 3:00 AM UTC daily

## Deployment

```bash
# Docker
docker build -t orbit-tracker .
docker run -e TELEGRAM_BOT_TOKEN=xxx -e HELIUS_API_KEY=yyy -v orbit-data:/data orbit-tracker

# Fly.io
fly launch --no-deploy
fly volumes create orbit_data --size 1
fly secrets set TELEGRAM_BOT_TOKEN=xxx HELIUS_API_KEY=yyy
fly deploy
```

Health check: `GET http://localhost:8080/health` returns JSON with bot, WebSocket, and API status.

## Related Repositories

### Orbit Finance DEX Adapter API
**Repo:** `Cipherlabsx/orbit_finance_dex_adapter_api`

The backend API that this bot consumes. Built with Fastify + TypeScript + Supabase. Provides:
- REST endpoints: `/pools`, `/trades/:pool`, `/volumes`, `/candles/:pool`, `/prices`, `/streamflow/vaults`
- WebSocket streaming of live trade events (ticket-based auth)
- On-chain indexing of all DLMM pool events

**Key endpoints used by this bot:**
- `GET /api/v1/pools` - Pool listings with pricing and liquidity
- `GET /api/v1/trades/:pool` - Trade history per pool
- `GET /api/v1/volumes?tf=24h` - Volume data by timeframe
- `GET /api/v1/candles/:pool?tf=15m` - OHLCV candlestick data
- `GET /api/v1/ws-ticket` + `WS /api/v1/ws` - Real-time trade stream
- `GET /api/v1/streamflow/stakes/:owner` - Staking positions
- `POST /api/v1/rewards/holder/claimable` - Reward calculations

### Launchr
**Repo:** `jorger3301/Launchr`

Full-stack Solana token launchpad with bonding curves and auto-graduation to Orbit Finance DLMM pools. Contains reusable patterns:

- **CacheService** (Redis + in-memory fallback with TTL) - more robust than current in-memory-only caching
- **Token-bucket rate limiter** with burst support and secure IP extraction
- **RPC load balancer** with circuit breaker pattern (weighted round-robin, exponential backoff)
- **EventEmitter-based service communication** for decoupled data flow
- **Trading anomaly detection** (whale trades, velocity spikes, wash trading, volume anomalies)
- **Pyth oracle price service** with staleness/confidence validation
- **WebSocket service** with multi-layered security (connection limits, message rate limiting, heartbeat)
- **Zod validation middleware** for Express (reusable pattern for command argument validation)

## Improvement Opportunities (from Launchr & DEX Adapter patterns)

These are patterns from the sister repositories that could enhance this bot:

1. **Modularize into services** - Extract the monolithic index.js into a service-oriented architecture using EventEmitter for decoupled communication (pattern from Launchr backend)
2. **Redis-backed caching with fallback** - Replace pure in-memory caches with Redis + in-memory fallback for persistence across restarts (Launchr `CacheService`)
3. **Circuit breaker for RPC calls** - Add circuit breaker pattern to Solana RPC calls to prevent cascading failures when nodes are down (Launchr `load-balancer.ts`)
4. **Trading anomaly alerts** - Port the monitoring service from Launchr to detect whale trades, wash trading, velocity spikes, and volume anomalies
5. **Structured logging** - Replace console.log-based logging with Winston/Pino for structured JSON logs, rotation, and levels (Launchr `logger.ts`)
6. **TypeScript migration** - The DEX adapter API is TypeScript; migrating would improve maintainability and catch bugs at compile time
7. **Reward tracking commands** - The DEX adapter exposes `/rewards/holder/claimable` and `/rewards/nft/claimable` endpoints that aren't yet surfaced in the bot
8. **Pool creation notifications** - The DEX adapter has pool creation endpoints; the bot could alert users when new pools are created
9. **Bin distribution visualization** - The DEX adapter exposes `/bins/:pool` with price bin data; could be rendered as a liquidity depth chart
10. **Pyth oracle integration** - Use validated oracle prices (with staleness/confidence checks) instead of relying solely on DEX/aggregator prices

## Coding Conventions

- Single-file monolithic design (intentional for simplicity and deployment)
- Section dividers with `═══` comment blocks
- `fetchWithRetry()` for all HTTP calls
- `safeAnswer(ctx)` wrapper for all Telegram callback handlers
- Zod for config validation
- `dayjs` for date formatting, `numeral` for number formatting
- User state machine pattern for multi-step command flows (e.g., wallet input, search)
- Inline keyboard buttons use `action:param:value` naming convention
- All amounts displayed in USD with appropriate precision
- SOL and CIPHER prices fetched from multiple sources with fallback chain
