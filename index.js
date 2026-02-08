// ═══════════════════════════════════════════════════════════════════════════════
// ORBIT TRACKER v11.0 - Production Grade Telegram Bot
// ═══════════════════════════════════════════════════════════════════════════════
// Features: Portfolio tracking, Trade alerts, LP monitoring, Whale tracking,
//           PnL Leaderboards, OHLCV Charts, Liquidity Alerts
// Tech: SQLite database, node-cron scheduling, PM2 compatible
// SDKs: Helius SDK, Solana Web3.js, Streamflow, Chart.js
// ═══════════════════════════════════════════════════════════════════════════════

'use strict';

// Load environment variables first (before anything else)
require('dotenv').config();

const { Telegraf, Markup } = require('telegraf');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const http = require('http');
const Database = require('better-sqlite3');
const cron = require('node-cron');
const dayjs = require('dayjs');
const relativeTime = require('dayjs/plugin/relativeTime');
const utc = require('dayjs/plugin/utc');
const numeral = require('numeral');
const { z } = require('zod');

// Solana SDKs
const { Helius } = require('helius-sdk');
const { Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
// Chart generation - DISABLED for Railway compatibility
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');

// Initialize dayjs plugins
dayjs.extend(relativeTime);
dayjs.extend(utc);

// Chart renderer (lazy init to save memory)
let chartRenderer = null;
function getChartRenderer() {
  if (!chartRenderer) {
    chartRenderer = new ChartJSNodeCanvas({ 
      width: 800, 
      height: 400,
      backgroundColour: '#1a1a2e'
    });
  }
  return chartRenderer;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIG (from environment variables with sensible defaults)
// ═══════════════════════════════════════════════════════════════════════════════
const CONFIG = {
  // Required
  botToken: process.env.TELEGRAM_BOT_TOKEN || '',
  heliusKey: process.env.HELIUS_API_KEY || '',
  
  // API Endpoints
  orbitApi: process.env.ORBIT_API || 'https://orbit-dex.api.cipherlabsx.com/api/v1',
  
  // Token
  cipherMint: 'Ciphern9cCXtms66s8Mm6wCFC27b2JProRQLYmiLMH3N',
  
  // Intervals
  wsReconnectDelay: 15000,
  poolRefreshInterval: parseInt(process.env.POOL_REFRESH_INTERVAL) || 300000,
  priceRefreshInterval: parseInt(process.env.PRICE_REFRESH_INTERVAL) || 300000,
  tradesPollInterval: parseInt(process.env.TRADES_POLL_INTERVAL) || 60000,
  portfolioAutoSyncInterval: 5 * 60 * 1000,
  
  // Limits
  maxWalletsPerUser: parseInt(process.env.MAX_WALLETS_PER_USER) || 10,
  maxRecentAlerts: parseInt(process.env.MAX_RECENT_ALERTS) || 10,
  maxWatchlistItems: parseInt(process.env.MAX_WATCHLIST_ITEMS) || 50,
  maxCacheSize: parseInt(process.env.MAX_CACHE_SIZE) || 1000,
  
  // Features
  debug: process.env.DEBUG === 'true',
  saveDebounceMs: 2000,
  
  // Daily Digest
  dailyDigestHour: parseInt(process.env.DAILY_DIGEST_HOUR) || 9,
  dailyDigestMinute: parseInt(process.env.DAILY_DIGEST_MINUTE) || 0,
};

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING (professional grade with levels)
// ═══════════════════════════════════════════════════════════════════════════════
const log = {
  info: (...args) => console.log(`[${new Date().toISOString()}] [INFO]`, ...args),
  warn: (...args) => console.warn(`[${new Date().toISOString()}] [WARN]`, ...args),
  error: (...args) => console.error(`[${new Date().toISOString()}] [ERROR]`, ...args),
  debug: (...args) => { if (CONFIG.debug) console.log(`[${new Date().toISOString()}] [DEBUG]`, ...args); },
};

// Validate required config
if (!CONFIG.botToken) {
  log.error('TELEGRAM_BOT_TOKEN is required. Set it in .env file.');
  process.exit(1);
}

if (!CONFIG.heliusKey) {
  log.warn('HELIUS_API_KEY not set. Some features may not work.');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SOLANA SDK INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════════

// Helius SDK - for enhanced API calls
let helius = null;
if (CONFIG.heliusKey) {
  try {
    helius = new Helius(CONFIG.heliusKey);
    log.info('✅ Helius SDK initialized');
  } catch (e) {
    log.warn('⚠️ Helius SDK init failed, falling back to HTTP:', e.message);
  }
}

// Solana Web3.js Connection - for direct RPC calls
const solanaConnection = new Connection(
  `https://mainnet.helius-rpc.com/?api-key=${CONFIG.heliusKey}`,
  {
    commitment: 'confirmed',
    confirmTransactionInitialTimeout: 60000,
  }
);

// Backup connection (free, no API key)
const solanaBackupConnection = new Connection(
  'https://api.mainnet-beta.solana.com',
  { commitment: 'confirmed' }
);

// Helper to get working connection
async function getConnection() {
  try {
    // Test primary connection
    await solanaConnection.getSlot();
    return solanaConnection;
  } catch (e) {
    log.debug('Primary RPC failed, using backup');
    return solanaBackupConnection;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DIRECT SOLANA HELPERS (using @solana/web3.js)
// ═══════════════════════════════════════════════════════════════════════════════

// Get SOL balance directly from chain
async function getSolBalance(walletAddress) {
  try {
    const pubkey = new PublicKey(walletAddress);
    const conn = await getConnection();
    const balance = await conn.getBalance(pubkey);
    return balance / LAMPORTS_PER_SOL;
  } catch (e) {
    log.debug(`getSolBalance failed for ${walletAddress}:`, e.message);
    return null;
  }
}

// Get token accounts directly from chain
async function getTokenAccounts(walletAddress) {
  try {
    const pubkey = new PublicKey(walletAddress);
    const conn = await getConnection();
    
    const tokenAccounts = await conn.getParsedTokenAccountsByOwner(pubkey, {
      programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
    });
    
    return tokenAccounts.value.map(account => {
      const info = account.account.data.parsed.info;
      return {
        mint: info.mint,
        balance: parseFloat(info.tokenAmount.uiAmount || 0),
        decimals: info.tokenAmount.decimals,
        address: account.pubkey.toString(),
      };
    }).filter(t => t.balance > 0);
  } catch (e) {
    log.debug(`getTokenAccounts failed for ${walletAddress}:`, e.message);
    return [];
  }
}

// Get recent transactions for a wallet
async function getRecentTransactions(walletAddress, limit = 10) {
  try {
    const pubkey = new PublicKey(walletAddress);
    const conn = await getConnection();
    
    const signatures = await conn.getSignaturesForAddress(pubkey, { limit });
    return signatures.map(sig => ({
      signature: sig.signature,
      slot: sig.slot,
      timestamp: sig.blockTime ? sig.blockTime * 1000 : null,
      err: sig.err,
    }));
  } catch (e) {
    log.debug(`getRecentTransactions failed:`, e.message);
    return [];
  }
}

// Orbit API endpoints helper
const ORBIT = {
  health: () => `${CONFIG.orbitApi}/health`,
  dex: () => `${CONFIG.orbitApi}/dex`,
  pools: () => `${CONFIG.orbitApi}/pools`,
  pool: (id) => `${CONFIG.orbitApi}/pools/${id}`,
  trades: (poolId, limit = 50) => `${CONFIG.orbitApi}/trades/${poolId}?limit=${limit}`,
  asset: (mint) => `${CONFIG.orbitApi}/asset?id=${mint}`,
  volumes: (tf) => tf ? `${CONFIG.orbitApi}/volumes?tf=${tf}` : `${CONFIG.orbitApi}/volumes`,
  latestBlock: () => `${CONFIG.orbitApi}/latest-block`,
  candles: (poolId, tf = '15m', limit = 100) => `${CONFIG.orbitApi}/candles/${poolId}?tf=${tf}&limit=${limit}`,
  wsTicket: () => `${CONFIG.orbitApi}/ws-ticket`,
};

const HELIUS = {
  rpc: `https://mainnet.helius-rpc.com/?api-key=${CONFIG.heliusKey}`,
  wss: `wss://mainnet.helius-rpc.com/?api-key=${CONFIG.heliusKey}`,
  api: `https://api-mainnet.helius-rpc.com/v0`,
};

const JUPITER = {
  price: 'https://price.jup.ag/v6/price',
  tokens: 'https://token.jup.ag/all',
};

// Backup APIs (all free, no keys required)
const BACKUP_APIS = {
  // Price APIs
  dexscreener: 'https://api.dexscreener.com/latest/dex/tokens',
  coingecko: 'https://api.coingecko.com/api/v3/simple/price',
  coingeckoTokens: 'https://api.coingecko.com/api/v3/coins/solana/contract',
  birdeye: 'https://public-api.birdeye.so/defi/price',
  
  // Token list backups
  solanaTokenList: 'https://raw.githubusercontent.com/solana-labs/token-list/main/src/tokens/solana.tokenlist.json',
  
  // RPC backups (public endpoints)
  solanaRpc: 'https://api.mainnet-beta.solana.com',
  ankrRpc: 'https://rpc.ankr.com/solana',
  
  // Solscan API (free tier: 100 req/min)
  solscan: 'https://api.solscan.io',
  solscanPublic: 'https://public-api.solscan.io',
  
  // Metaplex (for token metadata)
  metaplex: 'https://api.metaplex.solana.com',
};

// Solscan API helper
const SOLSCAN = {
  tx: (sig) => `${BACKUP_APIS.solscanPublic}/transaction/${sig}`,
  account: (addr) => `${BACKUP_APIS.solscanPublic}/account/${addr}`,
  token: (mint) => `${BACKUP_APIS.solscanPublic}/token/meta?token=${mint}`,
  tokenHolders: (mint) => `${BACKUP_APIS.solscanPublic}/token/holders?token=${mint}&limit=10`,
  accountTokens: (addr) => `${BACKUP_APIS.solscanPublic}/account/tokens?account=${addr}`,
};

// Birdeye API helper (free tier: 1000 req/day)
const BIRDEYE = {
  base: 'https://public-api.birdeye.so',
  price: (mint) => `https://public-api.birdeye.so/defi/price?address=${mint}`,
  multiPrice: (mints) => `https://public-api.birdeye.so/defi/multi_price?list_address=${mints.join(',')}`,
  overview: (mint) => `https://public-api.birdeye.so/defi/token_overview?address=${mint}`,
  security: (mint) => `https://public-api.birdeye.so/defi/token_security?address=${mint}`,
  holders: (mint) => `https://public-api.birdeye.so/defi/v3/token/holder?address=${mint}&limit=10`,
  walletPnL: (wallet) => `https://public-api.birdeye.so/v1/wallet/token_list?wallet=${wallet}`,
  walletNetWorth: (wallet) => `https://public-api.birdeye.so/v1/wallet/token_list?wallet=${wallet}`,
  topTraders: (mint) => `https://public-api.birdeye.so/defi/v2/tokens/top_traders?address=${mint}&limit=5`,
  trades: (mint) => `https://public-api.birdeye.so/defi/txs/token?address=${mint}&limit=20`,
};

// Birdeye API key (optional - works without key at lower rate limits)
const BIRDEYE_KEY = process.env.BIRDEYE_API_KEY || '';

// Rate limiters (initialized later after class is defined)
let birdeyeLimiter, heliusLimiter, jupiterLimiter;

// Helper for Birdeye requests with rate limiting
async function birdeyeFetch(url) {
  if (birdeyeLimiter) await birdeyeLimiter.acquire();
  const headers = { 'accept': 'application/json' };
  if (BIRDEYE_KEY) headers['X-API-KEY'] = BIRDEYE_KEY;
  return fetchWithRetry(url, { headers }, 2);
}

// API Health tracking
const apiHealth = {
  jupiter: { status: 'unknown', lastCheck: 0, failures: 0 },
  dexscreener: { status: 'unknown', lastCheck: 0, failures: 0 },
  coingecko: { status: 'unknown', lastCheck: 0, failures: 0 },
  birdeye: { status: 'unknown', lastCheck: 0, failures: 0 },
  helius: { status: 'unknown', lastCheck: 0, failures: 0 },
  orbit: { status: 'unknown', lastCheck: 0, failures: 0 },
  solscan: { status: 'unknown', lastCheck: 0, failures: 0 },
  metaplex: { status: 'unknown', lastCheck: 0, failures: 0 },
};

function updateApiHealth(api, success) {
  if (!apiHealth[api]) return;
  apiHealth[api].lastCheck = Date.now();
  if (success) {
    apiHealth[api].status = 'ok';
    apiHealth[api].failures = 0;
  } else {
    apiHealth[api].failures++;
    apiHealth[api].status = apiHealth[api].failures >= 3 ? 'down' : 'degraded';
  }
}

// Common token mints
const MINTS = {
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  CIPHER: 'Ciphern9cCXtms66s8Mm6wCFC27b2JProRQLYmiLMH3N',
  CIPHER_STAKE_POOL: 'Fh7u35PsxFWBWNE5Pme2yffixJ5H7YocAymJHs6L73N', // Streamflow Stake Pool (also vault)
  CIPHER_STAKING_TOKEN: '3gRFc7UCQyRr9BQvV61q6QWZAo8TvAK69sNaycTLzisR', // sCIPHER receipt token
  CIPHER_VESTING: '3BiB8sNFaGfPm1NgRZcj5SoSQhj18Mkw6zhumLj3zrha', // Streamflow vesting contract
};

// Streamflow Staking Program ID
const STREAMFLOW_STAKING_PROGRAM = 'STAKEvGqQTtzJZH6BWDcbpzXXn2BBerPAgQ3EGLN2GH';

// Orbit Finance Program ID
const ORBIT_PROGRAM_ID = 'Fn3fA3fjsmpULNL7E9U79jKTe1KHxPtQeWdURCbJXCnM';

// Transaction type enum
const TX_TYPE = {
  SWAP: 'swap',
  LP_ADD: 'lp_add',
  LP_REMOVE: 'lp_remove',
  CLOSE_POSITION: 'close_position',
  LOCK_LIQUIDITY: 'lock_liquidity',
  UNLOCK_LIQUIDITY: 'unlock_liquidity',
  POOL_INIT: 'pool_init',
  FEES_DISTRIBUTED: 'fees_distributed',
  CLAIM_REWARDS: 'claim_rewards',
  SYNC_STAKE: 'sync_stake',
  CLOSE_POOL: 'close_pool',
  PROTOCOL_FEES: 'protocol_fees',
  ADMIN: 'admin',
  SETUP: 'setup',
  UNKNOWN: 'unknown',
};

/**
 * Anchor discriminators from the Orbit Finance IDL
 * These 8-byte discriminators are used to identify instruction/event types
 */
const ORBIT_DISCRIMINATORS = {
  instructions: {
    // Swap
    swap: [248, 198, 158, 145, 225, 117, 135, 200],
    // Liquidity
    add_liquidity_v2: [126, 118, 210, 37, 80, 190, 19, 105],
    add_liquidity_batch: [254, 87, 215, 234, 0, 131, 76, 231],
    withdraw: [183, 18, 70, 156, 148, 109, 161, 34],
    close_position: [123, 134, 81, 0, 49, 68, 98, 98],
    // Pool management
    init_pool: [116, 233, 199, 204, 115, 159, 171, 36],
    close_pool: [140, 189, 209, 23, 239, 62, 239, 11],
    init_position: [197, 20, 10, 1, 97, 160, 177, 91],
    init_position_bin: [249, 110, 124, 16, 185, 55, 149, 13],
    create_bin_array: [107, 26, 23, 62, 137, 213, 131, 235],
    init_oracle: [78, 100, 33, 183, 96, 207, 60, 91],
    lock_liquidity: [179, 201, 236, 158, 212, 98, 70, 182],
    unlock_liquidity: [154, 98, 151, 31, 8, 180, 144, 1],
    // Protocol fees
    claim_protocol_fees: [34, 142, 219, 112, 109, 54, 133, 23],
    transfer_protocol_fees: [142, 148, 70, 57, 116, 166, 82, 111],
    // Staking / Rewards
    claim_holder_rewards: [79, 182, 142, 158, 108, 127, 120, 174],
    claim_nft_rewards: [155, 218, 162, 252, 207, 252, 197, 230],
    sync_holder_stake: [151, 230, 186, 138, 237, 187, 231, 155],
    // Admin / governance
    update_admin: [161, 176, 40, 213, 60, 184, 179, 228],
    update_authorities: [175, 228, 137, 18, 175, 70, 220, 165],
    update_fee_config: [104, 184, 103, 242, 88, 151, 107, 20],
    set_pause: [63, 32, 154, 2, 56, 103, 79, 45],
    set_pause_bits: [122, 45, 85, 156, 176, 64, 45, 83],
    unpause_override: [150, 175, 134, 15, 132, 92, 237, 185],
    // Global state init
    init_holder_global_state: [21, 10, 69, 39, 195, 87, 203, 148],
    init_nft_global_state: [126, 182, 160, 21, 28, 63, 16, 75],
    init_user_holder_state: [49, 178, 188, 199, 246, 133, 51, 222],
    init_user_nft_state: [175, 85, 43, 138, 194, 163, 71, 36],
    // Read-only
    view_farming_position: [29, 39, 65, 136, 187, 153, 243, 130],
  },
  events: {
    SwapExecuted: [150, 166, 26, 225, 28, 89, 38, 79],
    LiquidityDeposited: [218, 155, 74, 193, 59, 66, 94, 122],
    LiquidityWithdrawnUser: [142, 245, 211, 16, 66, 171, 36, 40],
    LiquidityWithdrawnAdmin: [236, 107, 253, 125, 227, 157, 155, 123],
    PoolInitialized: [100, 118, 173, 87, 12, 198, 254, 229],
    FeesDistributed: [209, 24, 174, 200, 236, 90, 154, 55],
    LiquidityLocked: [150, 201, 204, 183, 217, 13, 119, 185],
    ClaimHolderRewardsEvent: [97, 42, 168, 9, 85, 193, 87, 102],
    SyncHolderStakeEvent: [47, 69, 233, 184, 242, 2, 125, 106],
    // Admin / governance events
    AdminUpdated: [69, 82, 49, 171, 43, 3, 80, 161],
    AuthoritiesUpdated: [67, 41, 36, 180, 223, 84, 221, 76],
    FeeConfigUpdated: [45, 50, 42, 173, 193, 67, 52, 244],
    PauseUpdated: [203, 203, 33, 225, 130, 103, 90, 105],
    // Setup events
    BinArrayCreated: [124, 208, 24, 108, 92, 150, 57, 156],
    LiquidityBinCreated: [193, 62, 251, 203, 209, 242, 92, 48],
    PairRegistered: [125, 143, 112, 66, 5, 53, 110, 4],
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// ANCHOR DISCRIMINATOR DETECTION
// ═══════════════════════════════════════════════════════════════════════════════

function arraysEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// Detect from raw instruction data (8-byte discriminator)
function detectFromInstructionData(data) {
  if (!data || data.length < 8) return TX_TYPE.UNKNOWN;

  const disc = Array.from(data.slice(0, 8));
  const ix = ORBIT_DISCRIMINATORS.instructions;

  // Swap
  if (arraysEqual(disc, ix.swap)) return TX_TYPE.SWAP;
  // Liquidity add (single + batch)
  if (arraysEqual(disc, ix.add_liquidity_v2) || arraysEqual(disc, ix.add_liquidity_batch)) return TX_TYPE.LP_ADD;
  // Liquidity remove
  if (arraysEqual(disc, ix.withdraw)) return TX_TYPE.LP_REMOVE;
  // Close position (removes liquidity + closes account)
  if (arraysEqual(disc, ix.close_position)) return TX_TYPE.CLOSE_POSITION;
  // Liquidity locking/unlocking
  if (arraysEqual(disc, ix.lock_liquidity)) return TX_TYPE.LOCK_LIQUIDITY;
  if (arraysEqual(disc, ix.unlock_liquidity)) return TX_TYPE.UNLOCK_LIQUIDITY;
  // Pool/position management
  if (arraysEqual(disc, ix.init_pool)) return TX_TYPE.POOL_INIT;
  if (arraysEqual(disc, ix.close_pool)) return TX_TYPE.CLOSE_POOL;
  if (arraysEqual(disc, ix.init_position)) return TX_TYPE.LP_ADD; // opening a position = preparing to add liquidity
  // Protocol fees
  if (arraysEqual(disc, ix.claim_protocol_fees) || arraysEqual(disc, ix.transfer_protocol_fees)) return TX_TYPE.PROTOCOL_FEES;
  // Reward claims & staking
  if (arraysEqual(disc, ix.claim_holder_rewards) || arraysEqual(disc, ix.claim_nft_rewards)) return TX_TYPE.CLAIM_REWARDS;
  if (arraysEqual(disc, ix.sync_holder_stake)) return TX_TYPE.SYNC_STAKE;
  // Admin / governance
  if (arraysEqual(disc, ix.update_admin) || arraysEqual(disc, ix.update_authorities) ||
      arraysEqual(disc, ix.update_fee_config) || arraysEqual(disc, ix.set_pause) ||
      arraysEqual(disc, ix.set_pause_bits) || arraysEqual(disc, ix.unpause_override)) return TX_TYPE.ADMIN;
  // Setup / infrastructure
  if (arraysEqual(disc, ix.create_bin_array) || arraysEqual(disc, ix.init_oracle) ||
      arraysEqual(disc, ix.init_position_bin) || arraysEqual(disc, ix.init_holder_global_state) ||
      arraysEqual(disc, ix.init_nft_global_state) || arraysEqual(disc, ix.init_user_holder_state) ||
      arraysEqual(disc, ix.init_user_nft_state) || arraysEqual(disc, ix.view_farming_position)) return TX_TYPE.SETUP;

  return TX_TYPE.UNKNOWN;
}

// Detect from Anchor event logs
function detectFromLogs(logs) {
  if (!logs || !Array.isArray(logs)) return { type: TX_TYPE.UNKNOWN, eventName: null };
  
  for (const log of logs) {
    if (!log.startsWith('Program data: ')) continue;
    
    try {
      const base64 = log.slice('Program data: '.length).trim();
      const buffer = Buffer.from(base64, 'base64');
      if (buffer.length < 8) continue;
      
      const disc = Array.from(buffer.slice(0, 8));
      
      if (arraysEqual(disc, ORBIT_DISCRIMINATORS.events.SwapExecuted)) {
        return { type: TX_TYPE.SWAP, eventName: 'SwapExecuted' };
      }
      if (arraysEqual(disc, ORBIT_DISCRIMINATORS.events.LiquidityDeposited)) {
        return { type: TX_TYPE.LP_ADD, eventName: 'LiquidityDeposited' };
      }
      if (arraysEqual(disc, ORBIT_DISCRIMINATORS.events.LiquidityWithdrawnUser)) {
        return { type: TX_TYPE.LP_REMOVE, eventName: 'LiquidityWithdrawnUser' };
      }
      if (arraysEqual(disc, ORBIT_DISCRIMINATORS.events.LiquidityWithdrawnAdmin)) {
        return { type: TX_TYPE.LP_REMOVE, eventName: 'LiquidityWithdrawnAdmin' };
      }
      if (arraysEqual(disc, ORBIT_DISCRIMINATORS.events.PoolInitialized)) {
        return { type: TX_TYPE.POOL_INIT, eventName: 'PoolInitialized' };
      }
      if (arraysEqual(disc, ORBIT_DISCRIMINATORS.events.FeesDistributed)) {
        return { type: TX_TYPE.FEES_DISTRIBUTED, eventName: 'FeesDistributed' };
      }
      if (arraysEqual(disc, ORBIT_DISCRIMINATORS.events.LiquidityLocked)) {
        return { type: TX_TYPE.LOCK_LIQUIDITY, eventName: 'LiquidityLocked' };
      }
      if (arraysEqual(disc, ORBIT_DISCRIMINATORS.events.ClaimHolderRewardsEvent)) {
        return { type: TX_TYPE.CLAIM_REWARDS, eventName: 'ClaimRewards' };
      }
      if (arraysEqual(disc, ORBIT_DISCRIMINATORS.events.SyncHolderStakeEvent)) {
        return { type: TX_TYPE.SYNC_STAKE, eventName: 'SyncHolderStake' };
      }
      // Admin / governance events
      if (arraysEqual(disc, ORBIT_DISCRIMINATORS.events.AdminUpdated)) {
        return { type: TX_TYPE.ADMIN, eventName: 'AdminUpdated' };
      }
      if (arraysEqual(disc, ORBIT_DISCRIMINATORS.events.AuthoritiesUpdated)) {
        return { type: TX_TYPE.ADMIN, eventName: 'AuthoritiesUpdated' };
      }
      if (arraysEqual(disc, ORBIT_DISCRIMINATORS.events.FeeConfigUpdated)) {
        return { type: TX_TYPE.ADMIN, eventName: 'FeeConfigUpdated' };
      }
      if (arraysEqual(disc, ORBIT_DISCRIMINATORS.events.PauseUpdated)) {
        return { type: TX_TYPE.ADMIN, eventName: 'PauseUpdated' };
      }
      // Setup events
      if (arraysEqual(disc, ORBIT_DISCRIMINATORS.events.BinArrayCreated)) {
        return { type: TX_TYPE.SETUP, eventName: 'BinArrayCreated' };
      }
      if (arraysEqual(disc, ORBIT_DISCRIMINATORS.events.LiquidityBinCreated)) {
        return { type: TX_TYPE.SETUP, eventName: 'LiquidityBinCreated' };
      }
      if (arraysEqual(disc, ORBIT_DISCRIMINATORS.events.PairRegistered)) {
        return { type: TX_TYPE.POOL_INIT, eventName: 'PairRegistered' };
      }
    } catch (e) {
      // Continue to next log
    }
  }

  return { type: TX_TYPE.UNKNOWN, eventName: null };
}

// Get swap direction (buy/sell) from message fields
function getSwapDirection(message) {
  if (message.side) return message.side.toLowerCase();
  
  const inMint = (message.inMint || message.in_mint || message.inputMint || '').toLowerCase();
  const outMint = (message.outMint || message.out_mint || message.outputMint || '').toLowerCase();
  const baseMint = (message.baseMint || message.base_mint || '').toLowerCase();
  const quoteMint = (message.quoteMint || message.quote_mint || '').toLowerCase();
  
  const cipher = MINTS.CIPHER.toLowerCase();
  const sol = MINTS.SOL.toLowerCase();
  
  // Determine direction based on token flows
  if (inMint === quoteMint && outMint === baseMint) return 'buy';
  if (inMint === sol && outMint === cipher) return 'buy';
  if (inMint === baseMint && outMint === quoteMint) return 'sell';
  if (inMint === cipher && outMint === sol) return 'sell';
  if (outMint === cipher || outMint.includes('cipher')) return 'buy';
  if (inMint === cipher || inMint.includes('cipher')) return 'sell';
  
  return null;
}

/**
 * Main transaction type detection with multiple methods
 * Returns: { type: TX_TYPE, direction: string|null, confidence: 'high'|'medium'|'low'|'none' }
 */
function detectTransactionType(message) {
  if (!message) return { type: TX_TYPE.UNKNOWN, direction: null, confidence: 'none' };
  
  // Method 1: Explicit type/event fields (highest priority)
  const explicitType = (
    message.type || message.eventType || message.event || 
    message.action || message.instructionName || message.eventName || ''
  ).toLowerCase();
  
  if (explicitType.includes('swap') || explicitType === 'trade' || explicitType === 'swapexecuted') {
    return { type: TX_TYPE.SWAP, direction: getSwapDirection(message), confidence: 'high' };
  }
  if (explicitType.includes('add_liquidity') || explicitType.includes('addliquidity') ||
      explicitType.includes('deposit') || explicitType === 'lp_add' || explicitType === 'liquiditydeposited') {
    return { type: TX_TYPE.LP_ADD, direction: 'add', confidence: 'high' };
  }
  if (explicitType.includes('withdraw') || explicitType.includes('remove_liquidity') ||
      explicitType.includes('removeliquidity') || explicitType === 'lp_remove' ||
      explicitType.includes('liquiditywithdrawn')) {
    return { type: TX_TYPE.LP_REMOVE, direction: 'remove', confidence: 'high' };
  }
  if (explicitType.includes('close_position') || explicitType === 'closeposition') {
    return { type: TX_TYPE.CLOSE_POSITION, direction: 'remove', confidence: 'high' };
  }
  if (explicitType.includes('init_pool') || explicitType === 'poolinitialized') {
    return { type: TX_TYPE.POOL_INIT, direction: null, confidence: 'high' };
  }
  if (explicitType.includes('claim_holder_rewards') || explicitType.includes('claim_nft_rewards') ||
      explicitType.includes('claimrewards')) {
    return { type: TX_TYPE.CLAIM_REWARDS, direction: null, confidence: 'high' };
  }
  if (explicitType === 'feesdistributed' || explicitType === 'fees_distributed') {
    return { type: TX_TYPE.FEES_DISTRIBUTED, direction: null, confidence: 'high' };
  }
  if (explicitType.includes('lock_liquidity') || explicitType === 'liquiditylocked') {
    return { type: TX_TYPE.LOCK_LIQUIDITY, direction: null, confidence: 'high' };
  }
  if (explicitType.includes('unlock_liquidity') || explicitType === 'liquidityunlocked') {
    return { type: TX_TYPE.UNLOCK_LIQUIDITY, direction: null, confidence: 'high' };
  }
  if (explicitType.includes('sync_holder_stake') || explicitType === 'syncholderstakeevent') {
    return { type: TX_TYPE.SYNC_STAKE, direction: null, confidence: 'high' };
  }
  if (explicitType === 'init_position' || explicitType === 'initposition') {
    return { type: TX_TYPE.LP_ADD, direction: 'add', confidence: 'high' };
  }
  if (explicitType.includes('close_pool') || explicitType === 'closepool') {
    return { type: TX_TYPE.CLOSE_POOL, direction: null, confidence: 'high' };
  }
  if (explicitType.includes('claim_protocol_fees') || explicitType.includes('transfer_protocol_fees')) {
    return { type: TX_TYPE.PROTOCOL_FEES, direction: null, confidence: 'high' };
  }
  if (explicitType.includes('update_admin') || explicitType === 'adminupdated' ||
      explicitType.includes('update_authorities') || explicitType === 'authoritiesupdated' ||
      explicitType.includes('update_fee_config') || explicitType === 'feeconfigured' ||
      explicitType === 'feeconfigupdated' || explicitType.includes('set_pause') ||
      explicitType.includes('unpause') || explicitType === 'pauseupdated' ||
      explicitType.includes('set_pause_bits')) {
    return { type: TX_TYPE.ADMIN, direction: null, confidence: 'high' };
  }
  if (explicitType.includes('create_bin_array') || explicitType === 'binarraycreated' ||
      explicitType.includes('init_oracle') || explicitType.includes('init_position_bin') ||
      explicitType.includes('init_holder_global') || explicitType.includes('init_nft_global') ||
      explicitType.includes('init_user_holder') || explicitType.includes('init_user_nft') ||
      explicitType === 'liquiditybincreated' || explicitType.includes('view_farming')) {
    return { type: TX_TYPE.SETUP, direction: null, confidence: 'high' };
  }

  // Method 2: Instruction data discriminator (Anchor)
  if (message.instructionData || message.data) {
    const data = message.instructionData || message.data;
    let buffer;
    
    if (typeof data === 'string') {
      try { buffer = Buffer.from(data, 'base64'); } 
      catch { try { buffer = Buffer.from(data, 'hex'); } catch { buffer = null; } }
    } else if (Array.isArray(data) || Buffer.isBuffer(data)) {
      buffer = Buffer.from(data);
    }
    
    if (buffer) {
      const detected = detectFromInstructionData(buffer);
      if (detected !== TX_TYPE.UNKNOWN) {
        const direction = detected === TX_TYPE.SWAP ? getSwapDirection(message) :
                         detected === TX_TYPE.LP_ADD ? 'add' :
                         (detected === TX_TYPE.LP_REMOVE || detected === TX_TYPE.CLOSE_POSITION) ? 'remove' : null;
        return { type: detected, direction, confidence: 'high' };
      }
    }
  }

  // Method 3: Check logs for Anchor events
  if (message.logs) {
    const logResult = detectFromLogs(message.logs);
    if (logResult.type !== TX_TYPE.UNKNOWN) {
      const direction = logResult.type === TX_TYPE.SWAP ? getSwapDirection(message) :
                       logResult.type === TX_TYPE.LP_ADD ? 'add' :
                       logResult.type === TX_TYPE.LP_REMOVE ? 'remove' : null;
      return { type: logResult.type, direction, eventName: logResult.eventName, confidence: 'high' };
    }
  }
  
  // Method 4: Heuristic detection (fallback)
  if (message.sharesMinted || message.shares_minted) {
    return { type: TX_TYPE.LP_ADD, direction: 'add', confidence: 'medium' };
  }
  if (message.sharesBurned || message.shares_burned) {
    return { type: TX_TYPE.LP_REMOVE, direction: 'remove', confidence: 'medium' };
  }
  
  const hasAmountIn = !!(message.amountIn || message.amount_in);
  const hasAmountOut = !!(message.amountOut || message.amount_out);
  const hasInMint = !!(message.inMint || message.in_mint || message.inputMint);
  const hasOutMint = !!(message.outMint || message.out_mint || message.outputMint);
  
  if (hasAmountIn && hasAmountOut && hasInMint && hasOutMint) {
    const inMint = message.inMint || message.in_mint || message.inputMint;
    const outMint = message.outMint || message.out_mint || message.outputMint;
    if (inMint !== outMint) {
      return { type: TX_TYPE.SWAP, direction: getSwapDirection(message), confidence: 'medium' };
    }
  }
  
  const hasBaseAmount = !!(message.baseAmount || message.base_amount || message.baseAmountOut);
  const hasQuoteAmount = !!(message.quoteAmount || message.quote_amount || message.quoteAmountOut);
  
  if (hasBaseAmount && hasQuoteAmount && !hasAmountIn && !hasAmountOut) {
    if (message.baseAmountOut || message.quoteAmountOut) {
      return { type: TX_TYPE.LP_REMOVE, direction: 'remove', confidence: 'medium' };
    }
    return { type: TX_TYPE.LP_ADD, direction: 'add', confidence: 'medium' };
  }
  
  // Method 5: Trade-specific fields
  if (message.side || message.tradeType) {
    const side = (message.side || message.tradeType || '').toLowerCase();
    const direction = side === 'buy' ? 'buy' : side === 'sell' ? 'sell' : null;
    return { type: TX_TYPE.SWAP, direction, confidence: 'low' };
  }
  
  return { type: TX_TYPE.UNKNOWN, direction: null, confidence: 'none' };
}

// ═══════════════════════════════════════════════════════════════════════════════
// INPUT VALIDATION (Zod schemas)
// ═══════════════════════════════════════════════════════════════════════════════
const schemas = {
  // Solana wallet address (base58, 32-44 chars)
  walletAddress: z.string()
    .min(32, 'Address too short')
    .max(44, 'Address too long')
    .regex(/^[1-9A-HJ-NP-Za-km-z]+$/, 'Invalid Solana address'),
  
  // Token mint address
  mintAddress: z.string()
    .min(32, 'Mint too short')
    .max(44, 'Mint too long')
    .regex(/^[1-9A-HJ-NP-Za-km-z]+$/, 'Invalid mint address'),
  
  // Transaction signature
  txSignature: z.string()
    .min(64, 'Invalid signature')
    .max(88, 'Invalid signature')
    .regex(/^[1-9A-HJ-NP-Za-km-z]+$/, 'Invalid signature format'),
  
  // Threshold amount (positive number)
  threshold: z.number()
    .min(0, 'Must be positive')
    .max(1000000000, 'Too large'),
  
  // Chat ID
  chatId: z.number().int(),
  
  // Search query (prevent injection)
  searchQuery: z.string()
    .max(100, 'Query too long')
    .transform(s => s.replace(/[<>\"\'\\]/g, '')), // Remove potential XSS chars
};

// Sanitize user input (remove dangerous characters)
function sanitizeInput(input, maxLength = 100) {
  if (!input || typeof input !== 'string') return '';
  return input
    .trim()
    .slice(0, maxLength)
    .replace(/[<>\"\'\\`]/g, '') // Remove XSS vectors
    .replace(/[\x00-\x1F\x7F]/g, ''); // Remove control characters
}

// Validation helper functions
function isValidWallet(address) {
  try {
    schemas.walletAddress.parse(address);
    return true;
  } catch {
    return false;
  }
}

function isValidMint(mint) {
  try {
    schemas.mintAddress.parse(mint);
    return true;
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENHANCED FORMATTING (numeral + dayjs)
// ═══════════════════════════════════════════════════════════════════════════════

// Format currency amounts
function formatCurrency(value, compact = true) {
  if (value === null || value === undefined || isNaN(value)) return '--';
  if (value === 0) return '$0';
  const neg = value < 0;
  const abs = Math.abs(value);
  let formatted;
  if (compact) {
    if (abs >= 1e9) formatted = numeral(abs).format('$0.00a').toUpperCase();
    else if (abs >= 1e6) formatted = numeral(abs).format('$0.00a').toUpperCase();
    else if (abs >= 1e3) formatted = numeral(abs).format('$0.0a').toUpperCase();
    else if (abs >= 1) formatted = numeral(abs).format('$0.00');
    else if (abs >= 0.01) formatted = numeral(abs).format('$0.00');
    else formatted = '<$0.01';
  } else {
    formatted = numeral(abs).format('$0,0.00');
  }
  return neg ? `-${formatted}` : formatted;
}

// Format large numbers (for supplies, balances)
function formatNumber(value, decimals = 2) {
  if (value === null || value === undefined || isNaN(value)) return '0';
  if (value >= 1e9) return numeral(value).format('0.00a').toUpperCase();
  if (value >= 1e6) return numeral(value).format('0.00a').toUpperCase();
  if (value >= 1e3) return numeral(value).format('0.00a').toUpperCase();
  if (value >= 1) return numeral(value).format('0.' + '0'.repeat(decimals));
  if (value >= 0.0001) return value.toFixed(4);
  return value.toFixed(6);
}

// Format token prices (handles very small and large values)
function formatPrice(price) {
  if (!price || price === 0) return '$0';
  if (price >= 1000) return numeral(price).format('$0,0');
  if (price >= 1) return numeral(price).format('$0.00');
  if (price >= 0.01) return numeral(price).format('$0.0000');
  if (price >= 0.0001) return numeral(price).format('$0.000000');
  return '$' + price.toExponential(2);
}

// Format timestamps - relative time
function timeAgo(timestamp) {
  if (!timestamp) return 'Never';
  return dayjs(timestamp).fromNow();
}

// Get current time formatted
function nowFormatted() {
  return dayjs().utc().format('HH:mm');
}

if (!CONFIG.botToken) {
  log.error('❌ TELEGRAM_BOT_TOKEN required');
  process.exit(1);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SIMPLE RATE LIMITER
// ═══════════════════════════════════════════════════════════════════════════════
class RateLimiter {
  constructor(maxRequests, windowMs) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.requests = [];
  }
  
  async acquire() {
    const now = Date.now();
    // Remove old requests outside the window
    this.requests = this.requests.filter(t => now - t < this.windowMs);
    
    if (this.requests.length >= this.maxRequests) {
      // Wait until oldest request expires
      const waitTime = this.windowMs - (now - this.requests[0]) + 10;
      await new Promise(r => setTimeout(r, waitTime));
      return this.acquire();
    }
    
    this.requests.push(now);
    return true;
  }
}

// Rate limiters for different APIs
heliusLimiter = new RateLimiter(50, 1000); // 50 req/sec
birdeyeLimiter = new RateLimiter(10, 1000); // 10 req/sec
jupiterLimiter = new RateLimiter(30, 1000); // 30 req/sec

// ═══════════════════════════════════════════════════════════════════════════════
// BOUNDED CACHE (prevents memory leaks)
// ═══════════════════════════════════════════════════════════════════════════════
class BoundedCache {
  constructor(maxSize = CONFIG.maxCacheSize, ttlMs = 60000) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    this.cache = new Map();
  }
  
  set(key, value) {
    // Remove oldest entries if at capacity
    if (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value;
      this.cache.delete(oldest);
    }
    this.cache.set(key, { value, timestamp: Date.now() });
  }
  
  get(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;
    
    // Check TTL
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return null;
    }
    return entry.value;
  }
  
  has(key) {
    return this.get(key) !== null;
  }
  
  delete(key) {
    this.cache.delete(key);
  }
  
  clear() {
    this.cache.clear();
  }
  
  get size() {
    return this.cache.size;
  }
  
  // Clean expired entries
  prune() {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now - entry.timestamp > this.ttlMs) {
        this.cache.delete(key);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEBOUNCE UTILITY (for saves)
// ═══════════════════════════════════════════════════════════════════════════════
function debounce(fn, delay) {
  let timeoutId = null;
  let pendingPromise = null;
  let pendingResolve = null;

  return function(...args) {
    // Don't reset timer — prevents starvation from rapid calls
    if (!pendingPromise) {
      pendingPromise = new Promise(resolve => {
        pendingResolve = resolve;
      });
    }

    if (timeoutId) return pendingPromise;

    timeoutId = setTimeout(() => {
      const result = fn.apply(this, args);
      pendingResolve(result);
      pendingPromise = null;
      pendingResolve = null;
      timeoutId = null;
    }, delay);

    return pendingPromise;
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// RETRY UTILITY
// ═══════════════════════════════════════════════════════════════════════════════
async function fetchWithRetry(url, options = {}, maxRetries = 3, timeoutMs = 15000) {
  let lastError;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      
      const res = await fetch(url, {
        ...options,
        headers: { 'Accept': 'application/json', ...options.headers },
        signal: controller.signal,
      });
      
      clearTimeout(timeout);
      
      if (res.ok) return res;
      if (res.status === 429) {
        // Rate limited - wait longer
        await new Promise(r => setTimeout(r, 1000 * (i + 1)));
        continue;
      }
      lastError = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastError = e;
      if (e.name === 'AbortError') {
        lastError = new Error('Request timeout');
      }
      await new Promise(r => setTimeout(r, 500 * (i + 1))); // Exponential backoff
    }
  }
  throw lastError;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRICE CACHE (Multi-Source with Fallbacks)
// ═══════════════════════════════════════════════════════════════════════════════
const priceCache = new Map();
let lastPriceUpdate = 0;
let priceApiStatus = 'unknown';

async function fetchPrices() {
  let success = false;
  
  // === PRIMARY: Jupiter API ===
  try {
    const solRes = await fetchWithRetry(`${JUPITER.price}?ids=SOL`);
    const solData = await solRes.json();
    if (solData?.data?.SOL?.price) {
      priceCache.set(MINTS.SOL, {
        price: parseFloat(solData.data.SOL.price),
        updatedAt: Date.now(),
        source: 'jupiter',
      });
      success = true;
      updateApiHealth('jupiter', true);
    }
    
    // Fetch other tokens from Jupiter
    const mintsToFetch = new Set([MINTS.CIPHER]);
    pools.forEach(p => {
      const base = p.baseMint || p.base;
      const quote = p.quoteMint || p.quote;
      if (base && base !== MINTS.SOL && base !== MINTS.USDC && base !== MINTS.USDT) {
        mintsToFetch.add(base);
      }
      if (quote && quote !== MINTS.SOL && quote !== MINTS.USDC && quote !== MINTS.USDT) {
        mintsToFetch.add(quote);
      }
    });
    
    const mintArray = [...mintsToFetch];
    for (let i = 0; i < mintArray.length; i += 50) {
      const batch = mintArray.slice(i, i + 50);
      try {
        const res = await fetchWithRetry(`${JUPITER.price}?ids=${batch.join(',')}`);
        const data = await res.json();
        if (data?.data) {
          for (const [key, info] of Object.entries(data.data)) {
            if (info?.price) {
              priceCache.set(info.id || key, {
                price: parseFloat(info.price),
                updatedAt: Date.now(),
                source: 'jupiter',
              });
            }
          }
        }
      } catch (e) {
        log.warn(`⚠️ Jupiter batch ${Math.floor(i/50)+1} failed:`, e.message);
      }
      if (i + 50 < mintArray.length) await new Promise(r => setTimeout(r, 100));
    }
    
    if (success) {
      priceApiStatus = 'jupiter';
      lastPriceUpdate = Date.now();
      log.info(`💰 Jupiter: SOL=$${getPrice(MINTS.SOL)?.toFixed(2)}, ${priceCache.size} tokens`);
      return;
    }
  } catch (e) {
    log.warn('⚠️ Jupiter API failed:', e.message);
    updateApiHealth('jupiter', false);
  }
  
  // === BACKUP 1: DexScreener API ===
  try {
    const dexRes = await fetchWithRetry(`${BACKUP_APIS.dexscreener}/${MINTS.SOL}`);
    const dexData = await dexRes.json();
    if (dexData?.pairs?.[0]?.priceUsd) {
      priceCache.set(MINTS.SOL, {
        price: parseFloat(dexData.pairs[0].priceUsd),
        updatedAt: Date.now(),
        source: 'dexscreener',
      });
      success = true;
      priceApiStatus = 'dexscreener';
      updateApiHealth('dexscreener', true);
      
      // Try to get CIPHER price too
      try {
        const cipherRes = await fetchWithRetry(`${BACKUP_APIS.dexscreener}/${MINTS.CIPHER}`);
        const cipherData = await cipherRes.json();
        if (cipherData?.pairs?.[0]?.priceUsd) {
          priceCache.set(MINTS.CIPHER, {
            price: parseFloat(cipherData.pairs[0].priceUsd),
            updatedAt: Date.now(),
            source: 'dexscreener',
          });
        }
      } catch (e) {}
      
      lastPriceUpdate = Date.now();
      log.info(`💰 DexScreener (backup): SOL=$${getPrice(MINTS.SOL)?.toFixed(2)}`);
      return;
    }
  } catch (e) {
    log.warn('⚠️ DexScreener API failed:', e.message);
    updateApiHealth('dexscreener', false);
  }
  
  // === BACKUP 2: Birdeye API ===
  try {
    const beRes = await birdeyeFetch(BIRDEYE.price(MINTS.SOL));
    const beData = await beRes.json();
    if (beData?.data?.value) {
      priceCache.set(MINTS.SOL, {
        price: parseFloat(beData.data.value),
        updatedAt: Date.now(),
        source: 'birdeye',
      });
      success = true;
      priceApiStatus = 'birdeye';
      updateApiHealth('birdeye', true);
      
      // Try to get CIPHER price too
      try {
        const cipherRes = await birdeyeFetch(BIRDEYE.price(MINTS.CIPHER));
        const cipherData = await cipherRes.json();
        if (cipherData?.data?.value) {
          priceCache.set(MINTS.CIPHER, {
            price: parseFloat(cipherData.data.value),
            updatedAt: Date.now(),
            source: 'birdeye',
          });
        }
      } catch (e) {}
      
      lastPriceUpdate = Date.now();
      log.info(`💰 Birdeye (backup): SOL=$${getPrice(MINTS.SOL)?.toFixed(2)}`);
      return;
    }
  } catch (e) {
    log.warn('⚠️ Birdeye API failed:', e.message);
    updateApiHealth('birdeye', false);
  }
  
  // === BACKUP 3: CoinGecko API ===
  try {
    const cgRes = await fetchWithRetry(`${BACKUP_APIS.coingecko}?ids=solana&vs_currencies=usd`);
    const cgData = await cgRes.json();
    if (cgData?.solana?.usd) {
      priceCache.set(MINTS.SOL, {
        price: parseFloat(cgData.solana.usd),
        updatedAt: Date.now(),
        source: 'coingecko',
      });
      success = true;
      priceApiStatus = 'coingecko';
      updateApiHealth('coingecko', true);
      lastPriceUpdate = Date.now();
      log.info(`💰 CoinGecko (backup): SOL=$${cgData.solana.usd}`);
      return;
    }
  } catch (e) {
    log.warn('⚠️ CoinGecko API failed:', e.message);
    updateApiHealth('coingecko', false);
  }
  
  if (!success) {
    priceApiStatus = 'error';
    log.error('❌ All price APIs failed!');
  }
}

function getPrice(mint) {
  if (!mint) return null;
  if (mint === MINTS.USDC || mint === MINTS.USDT) return 1;
  
  const cached = priceCache.get(mint);
  if (cached && Date.now() - cached.updatedAt < CONFIG.priceRefreshInterval * 2) {
    return cached.price;
  }
  return null;
}

function getSolPrice() {
  const price = getPrice(MINTS.SOL);
  if (price) return price;
  log.warn('⚠️ No SOL price available');
  return null;
}

// Get CIPHER price - tries cache first, then fetches from APIs
async function getCipherPrice() {
  // Try cache first
  let price = getPrice(MINTS.CIPHER);
  if (price && price > 0) return price;
  
  // Try DexScreener
  try {
    const res = await fetchWithRetry(`${BACKUP_APIS.dexscreener}/${MINTS.CIPHER}`, {}, 2, 5000);
    const data = await res.json();
    if (data?.pairs?.[0]?.priceUsd) {
      price = parseFloat(data.pairs[0].priceUsd);
      priceCache.set(MINTS.CIPHER, {
        price,
        updatedAt: Date.now(),
        source: 'dexscreener',
      });
      log.debug(`Fetched CIPHER price: $${price}`);
      return price;
    }
  } catch (e) {}
  
  // Try Birdeye
  try {
    const res = await birdeyeFetch(BIRDEYE.price(MINTS.CIPHER));
    const data = await res.json();
    if (data?.data?.value) {
      price = parseFloat(data.data.value);
      priceCache.set(MINTS.CIPHER, {
        price,
        updatedAt: Date.now(),
        source: 'birdeye',
      });
      log.debug(`Fetched CIPHER price from Birdeye: $${price}`);
      return price;
    }
  } catch (e) {}
  
  log.warn('⚠️ Could not fetch CIPHER price');
  return 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOKENS
// ═══════════════════════════════════════════════════════════════════════════════
const tokens = new Map([
  [MINTS.USDC, { symbol: 'USDC', decimals: 6 }],
  [MINTS.USDT, { symbol: 'USDT', decimals: 6 }],
  [MINTS.SOL, { symbol: 'SOL', decimals: 9 }],
  [MINTS.CIPHER, { symbol: 'CIPHER', decimals: 6 }],
]);

async function loadTokens() {
  // Primary: Jupiter token list
  try {
    const res = await fetchWithRetry(JUPITER.tokens);
    const data = await res.json();
    if (Array.isArray(data)) {
      data.forEach(t => tokens.set(t.address, { symbol: t.symbol, decimals: t.decimals }));
      log.info(`✅ Loaded ${data.length} tokens from Jupiter`);
      updateApiHealth('jupiter', true);
      return;
    }
  } catch (e) {
    log.warn('⚠️ Jupiter token list failed:', e.message);
    updateApiHealth('jupiter', false);
  }
  
  // Backup: Solana Labs token list
  try {
    const res = await fetchWithRetry(BACKUP_APIS.solanaTokenList);
    const data = await res.json();
    if (data?.tokens && Array.isArray(data.tokens)) {
      data.tokens.forEach(t => {
        if (t.chainId === 101) { // Mainnet only
          tokens.set(t.address, { symbol: t.symbol, decimals: t.decimals });
        }
      });
      log.info(`✅ Loaded ${tokens.size} tokens from Solana Labs (backup)`);
      return;
    }
  } catch (e) {
    log.warn('⚠️ Backup token list also failed:', e.message);
  }
  
  log.warn('⚠️ Using default tokens only');
}

// Dynamic token metadata lookup (for unknown tokens)
const pendingTokenLookups = new Set();

async function fetchTokenMetadata(mint) {
  if (!mint || tokens.has(mint) || pendingTokenLookups.has(mint)) return;
  pendingTokenLookups.add(mint);
  
  // Try Orbit /asset first (most relevant for Orbit pools)
  try {
    const res = await fetchWithRetry(ORBIT.asset(mint), {}, 2);
    const data = await res.json();
    if (data?.symbol || data?.ticker) {
      tokens.set(mint, { 
        symbol: data.symbol || data.ticker, 
        decimals: data.decimals || 6,
        name: data.name,
        source: 'orbit'
      });
      log.debug(`📡 Token metadata from Orbit: ${data.symbol || data.ticker}`);
      updateApiHealth('orbit', true);
      pendingTokenLookups.delete(mint);
      return;
    }
  } catch (e) {
    // Orbit doesn't have this token, try other sources
  }
  
  // Try Solscan (fast and reliable)
  try {
    const res = await fetchWithRetry(SOLSCAN.token(mint), {}, 2);
    const data = await res.json();
    if (data?.symbol) {
      tokens.set(mint, { 
        symbol: data.symbol, 
        decimals: data.decimals || 6,
        name: data.name,
        source: 'solscan'
      });
      log.debug(`📡 Token metadata from Solscan: ${data.symbol}`);
      updateApiHealth('solscan', true);
      pendingTokenLookups.delete(mint);
      return;
    }
  } catch (e) {
    updateApiHealth('solscan', false);
  }
  
  // Try DexScreener (has token info)
  try {
    const res = await fetchWithRetry(`${BACKUP_APIS.dexscreener}/${mint}`, {}, 2);
    const data = await res.json();
    if (data?.pairs?.[0]?.baseToken?.symbol) {
      const tokenInfo = data.pairs[0].baseToken;
      tokens.set(mint, { 
        symbol: tokenInfo.symbol, 
        decimals: 9, // DexScreener doesn't always provide decimals
        name: tokenInfo.name,
        source: 'dexscreener'
      });
      log.debug(`📡 Token metadata from DexScreener: ${tokenInfo.symbol}`);
      pendingTokenLookups.delete(mint);
      return;
    }
  } catch (e) {}
  
  // Try Metaplex via RPC (on-chain metadata)
  try {
    // Calculate Metaplex metadata PDA
    const METADATA_PROGRAM = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
    
    // Use Helius to get token metadata
    const res = await fetchWithRetry(`${HELIUS.api}/tokens/metadata?api-key=${CONFIG.heliusKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mintAccounts: [mint] })
    }, 2);
    
    const data = await res.json();
    if (data?.[0]?.onChainMetadata?.metadata?.data) {
      const meta = data[0].onChainMetadata.metadata.data;
      tokens.set(mint, { 
        symbol: meta.symbol?.replace(/\0/g, '').trim() || '???', 
        decimals: data[0].decimals || 6,
        name: meta.name?.replace(/\0/g, '').trim(),
        source: 'metaplex'
      });
      log.debug(`📡 Token metadata from Metaplex: ${meta.symbol}`);
      pendingTokenLookups.delete(mint);
      return;
    }
  } catch (e) {}
  
  pendingTokenLookups.delete(mint);
}

// Enhanced getSymbol that triggers async lookup
const getSymbol = (addr) => {
  if (!addr) return '???';
  const cached = tokens.get(addr);
  if (cached?.symbol) {
    // Escape markdown special characters in symbol
    return cached.symbol.replace(/[_*\[\]()~`>#+=|{}.!-]/g, '');
  }
  
  // Trigger async lookup for unknown tokens (don't await)
  fetchTokenMetadata(addr).catch(() => {});
  
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
};

const getDecimals = (addr) => tokens.get(addr)?.decimals || 6;
const formatPair = (base, quote) => `${getSymbol(base)}/${getSymbol(quote)}`;
const shortAddr = (addr) => !addr ? '???' : `${addr.slice(0, 4)}...${addr.slice(-4)}`;

// ═══════════════════════════════════════════════════════════════════════════════
// FORMATTERS
// ═══════════════════════════════════════════════════════════════════════════════
// Escape Markdown special characters
const escMd = (str) => {
  if (!str) return '';
  return String(str).replace(/[_*\[\]()~`>#+=|{}.!-]/g, '\\$&');
};

// Legacy formatting aliases (use new functions internally)
const fmt = (v) => formatCurrency(v, true);
const fmtPrice = (v) => formatPrice(v);
const fmtTime = () => nowFormatted();
const fmtDate = () => dayjs().utc().format('MMM D');

// ═══════════════════════════════════════════════════════════════════════════════
// USER STORAGE
// ═══════════════════════════════════════════════════════════════════════════════
const users = new Map();
const userStates = new Map();
const commandCooldowns = new Map(); // chatId -> lastCommandTime

// Input timeout - clear awaiting state after 5 minutes
const INPUT_TIMEOUT = 5 * 60 * 1000;

// Command cooldown - 1 second between commands
const COMMAND_COOLDOWN = 1000;

function setUserState(chatId, state) {
  userStates.set(chatId, { ...state, timestamp: Date.now() });
}

function getUserState(chatId) {
  const state = userStates.get(chatId);
  if (!state) return null;
  
  // Check if state has expired
  if (state.timestamp && Date.now() - state.timestamp > INPUT_TIMEOUT) {
    userStates.delete(chatId);
    return null;
  }
  return state;
}

function checkCooldown(chatId) {
  const lastCmd = commandCooldowns.get(chatId) || 0;
  const now = Date.now();
  if (now - lastCmd < COMMAND_COOLDOWN) {
    return false; // Still in cooldown
  }
  commandCooldowns.set(chatId, now);
  return true;
}

// Clean up old cooldown entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [chatId, timestamp] of commandCooldowns.entries()) {
    if (now - timestamp > 60000) { // 1 minute
      commandCooldowns.delete(chatId);
    }
  }
}, 60000);

// Use absolute path based on script location so data persists across updates
const SCRIPT_DIR = __dirname || path.dirname(process.argv[1] || '.');
const DATA_DIR = process.env.DATA_DIR || path.join(SCRIPT_DIR, 'data');
const DB_FILE = path.join(DATA_DIR, 'orbit-tracker.db');
const USERS_FILE = path.join(DATA_DIR, 'users.json'); // Legacy - for migration

// Ensure data directory exists
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    log.info(`📁 Created data directory: ${DATA_DIR}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SQLITE DATABASE
// ═══════════════════════════════════════════════════════════════════════════════
let db = null;

function initDatabase() {
  ensureDataDir();
  
  try {
    db = new Database(DB_FILE);
    
    // Enable WAL mode for better performance and crash safety
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');
    
    // Create tables
    db.exec(`
      -- Users table (main settings)
      CREATE TABLE IF NOT EXISTS users (
        chat_id INTEGER PRIMARY KEY,
        onboarded INTEGER DEFAULT 0,
        enabled INTEGER DEFAULT 1,
        blocked INTEGER DEFAULT 0,
        
        -- CIPHER alerts
        cipher_buys INTEGER DEFAULT 1,
        cipher_sells INTEGER DEFAULT 1,
        cipher_lp_add INTEGER DEFAULT 1,
        cipher_lp_remove INTEGER DEFAULT 1,
        cipher_threshold REAL DEFAULT 100,
        
        -- Other pool alerts
        track_other_pools INTEGER DEFAULT 1,
        other_lp_add INTEGER DEFAULT 1,
        other_lp_remove INTEGER DEFAULT 1,
        other_lp_threshold REAL DEFAULT 500,
        other_buys INTEGER DEFAULT 1,
        other_sells INTEGER DEFAULT 1,
        other_threshold REAL DEFAULT 500,
        
        -- Wallet alerts
        wallet_alerts INTEGER DEFAULT 1,

        -- New event alerts
        new_pool_alerts INTEGER DEFAULT 1,
        lock_alerts INTEGER DEFAULT 1,
        reward_alerts INTEGER DEFAULT 1,
        close_pool_alerts INTEGER DEFAULT 1,
        protocol_fee_alerts INTEGER DEFAULT 1,
        admin_alerts INTEGER DEFAULT 1,

        -- Snooze/quiet
        snoozed_until INTEGER DEFAULT 0,
        quiet_start INTEGER,
        quiet_end INTEGER,
        
        -- Daily digest
        daily_digest INTEGER DEFAULT 0,
        
        -- Stats (JSON)
        stats TEXT DEFAULT '{}',
        today_stats TEXT DEFAULT '{}',
        
        -- Portfolio data (JSON - complex nested data)
        portfolio TEXT DEFAULT '{}',
        my_wallet TEXT,
        
        -- Timestamps
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        last_active INTEGER DEFAULT 0,
        
        -- Version for schema migrations
        schema_version INTEGER DEFAULT 1
      );
      
      -- Watchlist table (many-to-many)
      CREATE TABLE IF NOT EXISTS watchlist (
        chat_id INTEGER NOT NULL,
        pool_id TEXT NOT NULL,
        added_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        PRIMARY KEY (chat_id, pool_id),
        FOREIGN KEY (chat_id) REFERENCES users(chat_id) ON DELETE CASCADE
      );
      
      -- Tracked tokens table
      CREATE TABLE IF NOT EXISTS tracked_tokens (
        chat_id INTEGER NOT NULL,
        mint TEXT NOT NULL,
        added_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        PRIMARY KEY (chat_id, mint),
        FOREIGN KEY (chat_id) REFERENCES users(chat_id) ON DELETE CASCADE
      );
      
      -- Whale wallets table (wallets users track for alerts)
      CREATE TABLE IF NOT EXISTS whale_wallets (
        chat_id INTEGER NOT NULL,
        wallet TEXT NOT NULL,
        label TEXT,
        added_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        PRIMARY KEY (chat_id, wallet),
        FOREIGN KEY (chat_id) REFERENCES users(chat_id) ON DELETE CASCADE
      );
      
      -- Portfolio wallets table
      CREATE TABLE IF NOT EXISTS portfolio_wallets (
        chat_id INTEGER NOT NULL,
        wallet TEXT NOT NULL,
        is_primary INTEGER DEFAULT 0,
        added_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        PRIMARY KEY (chat_id, wallet),
        FOREIGN KEY (chat_id) REFERENCES users(chat_id) ON DELETE CASCADE
      );
      
      -- Recent alerts table (last N alerts per user)
      CREATE TABLE IF NOT EXISTS recent_alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        pair TEXT,
        token TEXT,
        wallet TEXT,
        usd REAL,
        is_buy INTEGER,
        sig TEXT,
        time INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        FOREIGN KEY (chat_id) REFERENCES users(chat_id) ON DELETE CASCADE
      );
      
      -- Create indexes for fast lookups
      CREATE INDEX IF NOT EXISTS idx_recent_alerts_chat_id ON recent_alerts(chat_id);
      CREATE INDEX IF NOT EXISTS idx_recent_alerts_time ON recent_alerts(time DESC);
      CREATE INDEX IF NOT EXISTS idx_watchlist_chat_id ON watchlist(chat_id);
      CREATE INDEX IF NOT EXISTS idx_whale_wallets_wallet ON whale_wallets(wallet);
      CREATE INDEX IF NOT EXISTS idx_portfolio_wallets_chat_id ON portfolio_wallets(chat_id);

      -- Seen transactions table (persists dedup across restarts)
      CREATE TABLE IF NOT EXISTS seen_txs (
        sig TEXT PRIMARY KEY,
        added_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
      );
    `);

    // Add new columns for existing databases (safe: ALTER TABLE IF NOT EXISTS not supported,
    // so we catch the "duplicate column" error and ignore it)
    const newCols = [
      ['new_pool_alerts', 'INTEGER DEFAULT 1'],
      ['lock_alerts', 'INTEGER DEFAULT 1'],
      ['reward_alerts', 'INTEGER DEFAULT 1'],
      ['close_pool_alerts', 'INTEGER DEFAULT 1'],
      ['protocol_fee_alerts', 'INTEGER DEFAULT 1'],
      ['admin_alerts', 'INTEGER DEFAULT 1'],
    ];
    for (const [col, type] of newCols) {
      try { db.exec(`ALTER TABLE users ADD COLUMN ${col} ${type}`); }
      catch (e) { /* column already exists */ }
    }

    log.info(`✅ Database initialized: ${DB_FILE}`);

    // Check if we need to migrate from JSON
    if (fs.existsSync(USERS_FILE) && !hasMigratedFromJson()) {
      migrateFromJson();
    }
    
    return true;
  } catch (e) {
    log.error('❌ Database initialization failed:', e.message);
    return false;
  }
}

// Check if migration has been done
function hasMigratedFromJson() {
  try {
    const count = db.prepare('SELECT COUNT(*) as count FROM users').get();
    return count.count > 0;
  } catch (e) {
    return false;
  }
}

// Migrate data from JSON to SQLite
function migrateFromJson() {
  try {
    log.info('🔄 Migrating data from JSON to SQLite...');
    
    const data = JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
    
    const insertUser = db.prepare(`
      INSERT OR REPLACE INTO users (
        chat_id, onboarded, enabled, blocked,
        cipher_buys, cipher_sells, cipher_lp_add, cipher_lp_remove, cipher_threshold,
        track_other_pools, other_lp_add, other_lp_remove, other_lp_threshold,
        other_buys, other_sells, other_threshold,
        wallet_alerts, snoozed_until, quiet_start, quiet_end,
        stats, today_stats, portfolio, my_wallet, created_at, last_active
      ) VALUES (
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?
      )
    `);
    
    const insertWatchlist = db.prepare('INSERT OR IGNORE INTO watchlist (chat_id, pool_id) VALUES (?, ?)');
    const insertTrackedToken = db.prepare('INSERT OR IGNORE INTO tracked_tokens (chat_id, mint) VALUES (?, ?)');
    const insertWhaleWallet = db.prepare('INSERT OR IGNORE INTO whale_wallets (chat_id, wallet) VALUES (?, ?)');
    const insertPortfolioWallet = db.prepare('INSERT OR IGNORE INTO portfolio_wallets (chat_id, wallet, is_primary) VALUES (?, ?, ?)');
    const insertRecentAlert = db.prepare(`
      INSERT INTO recent_alerts (chat_id, type, pair, token, wallet, usd, is_buy, sig, time)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    const migrateAll = db.transaction(() => {
      for (const u of data) {
        // Insert main user record
        insertUser.run(
          u.chatId,
          u.onboarded ? 1 : 0,
          u.enabled !== false ? 1 : 0,
          u.blocked ? 1 : 0,
          u.cipherBuys !== false ? 1 : 0,
          u.cipherSells !== false ? 1 : 0,
          u.cipherLpAdd !== false ? 1 : 0,
          u.cipherLpRemove !== false ? 1 : 0,
          u.cipherThreshold || 100,
          u.trackOtherPools !== false ? 1 : 0,
          u.otherLpAdd !== false ? 1 : 0,
          u.otherLpRemove !== false ? 1 : 0,
          u.otherLpThreshold || 500,
          u.otherBuys !== false ? 1 : 0,
          u.otherSells !== false ? 1 : 0,
          u.otherThreshold || 500,
          u.walletAlerts !== false ? 1 : 0,
          u.snoozedUntil || 0,
          u.quietStart,
          u.quietEnd,
          JSON.stringify(u.stats || {}),
          JSON.stringify(u.todayStats || {}),
          JSON.stringify(u.portfolio || {}),
          u.myWallet,
          u.createdAt || Date.now(),
          u.lastActive || 0
        );
        
        // Insert watchlist items
        for (const poolId of (u.watchlist || [])) {
          insertWatchlist.run(u.chatId, poolId);
        }
        
        // Insert tracked tokens
        for (const mint of (u.trackedTokens || [])) {
          insertTrackedToken.run(u.chatId, mint);
        }
        
        // Insert whale wallets
        for (const wallet of (u.wallets || [])) {
          insertWhaleWallet.run(u.chatId, wallet);
        }
        
        // Insert portfolio wallets
        const portfolioWallets = u.portfolioWallets || [];
        if (u.myWallet && !portfolioWallets.includes(u.myWallet)) {
          portfolioWallets.unshift(u.myWallet);
        }
        portfolioWallets.forEach((wallet, i) => {
          insertPortfolioWallet.run(u.chatId, wallet, i === 0 ? 1 : 0);
        });
        
        // Insert recent alerts
        for (const alert of (u.recentAlerts || [])) {
          insertRecentAlert.run(
            u.chatId,
            alert.type || 'trade',
            alert.pair,
            alert.token,
            alert.wallet,
            alert.usd || 0,
            alert.isBuy ? 1 : 0,
            alert.sig,
            alert.time || Date.now()
          );
        }
      }
    });
    
    migrateAll();
    
    // Rename old JSON file to indicate migration complete
    fs.renameSync(USERS_FILE, USERS_FILE + '.migrated');
    
    log.info(`✅ Migrated ${data.length} users to SQLite`);
    
  } catch (e) {
    log.error('❌ Migration failed:', e.message);
    log.error(e.stack);
  }
}

// Load users from database into memory (uses the Map declared earlier)
function loadUsers() {
  if (!db) {
    log.error('Database not initialized');
    return;
  }
  
  try {
    const rows = db.prepare('SELECT * FROM users').all();
    
    for (const row of rows) {
      const user = dbRowToUser(row);
      
      // Load related data
      user.watchlist = db.prepare('SELECT pool_id FROM watchlist WHERE chat_id = ?').all(row.chat_id).map(r => r.pool_id);
      user.trackedTokens = db.prepare('SELECT mint FROM tracked_tokens WHERE chat_id = ?').all(row.chat_id).map(r => r.mint);
      user.wallets = db.prepare('SELECT wallet FROM whale_wallets WHERE chat_id = ?').all(row.chat_id).map(r => r.wallet);
      user.portfolioWallets = db.prepare('SELECT wallet FROM portfolio_wallets WHERE chat_id = ? ORDER BY is_primary DESC').all(row.chat_id).map(r => r.wallet);
      user.recentAlerts = db.prepare('SELECT * FROM recent_alerts WHERE chat_id = ? ORDER BY time DESC LIMIT ?').all(row.chat_id, CONFIG.maxRecentAlerts).map(r => ({
        type: r.type,
        pair: r.pair,
        token: r.token,
        wallet: r.wallet,
        usd: r.usd,
        isBuy: r.is_buy === 1,
        sig: r.sig,
        time: r.time,
      }));
      
      users.set(user.chatId, user);
    }
    
    log.info(`✅ Loaded ${users.size} users from database`);
  } catch (e) {
    log.error('❌ Failed to load users:', e.message);
  }
}

// Convert database row to user object
function dbRowToUser(row) {
  return {
    chatId: row.chat_id,
    onboarded: row.onboarded === 1,
    enabled: row.enabled === 1,
    blocked: row.blocked === 1,
    cipherBuys: row.cipher_buys === 1,
    cipherSells: row.cipher_sells === 1,
    cipherLpAdd: row.cipher_lp_add === 1,
    cipherLpRemove: row.cipher_lp_remove === 1,
    cipherThreshold: row.cipher_threshold,
    trackOtherPools: row.track_other_pools === 1,
    otherLpAdd: row.other_lp_add === 1,
    otherLpRemove: row.other_lp_remove === 1,
    otherLpThreshold: row.other_lp_threshold,
    otherBuys: row.other_buys === 1,
    otherSells: row.other_sells === 1,
    otherThreshold: row.other_threshold,
    walletAlerts: row.wallet_alerts === undefined ? true : row.wallet_alerts === 1,
    newPoolAlerts: row.new_pool_alerts === undefined ? true : row.new_pool_alerts === 1,
    lockAlerts: row.lock_alerts === undefined ? true : row.lock_alerts === 1,
    rewardAlerts: row.reward_alerts === undefined ? true : row.reward_alerts === 1,
    closePoolAlerts: row.close_pool_alerts === undefined ? true : row.close_pool_alerts === 1,
    protocolFeeAlerts: row.protocol_fee_alerts === undefined ? true : row.protocol_fee_alerts === 1,
    adminAlerts: row.admin_alerts === undefined ? true : row.admin_alerts === 1,
    snoozedUntil: row.snoozed_until,
    quietStart: row.quiet_start,
    quietEnd: row.quiet_end,
    dailyDigest: row.daily_digest === 1,
    stats: JSON.parse(row.stats || '{}'),
    todayStats: JSON.parse(row.today_stats || '{}'),
    portfolio: JSON.parse(row.portfolio || '{}'),
    myWallet: row.my_wallet,
    createdAt: row.created_at,
    lastActive: row.last_active,
    watchlist: [],
    trackedTokens: [],
    wallets: [],
    portfolioWallets: [],
    recentAlerts: [],
  };
}

// Save user to database (uses upsert to avoid ON DELETE CASCADE, wrapped in transaction)
function saveUser(user) {
  if (!db || !user) return;

  try {
    const saveTransaction = db.transaction(() => {
      // Upsert user record — ON CONFLICT UPDATE avoids DELETE CASCADE
      const stmt = db.prepare(`
        INSERT INTO users (
          chat_id, onboarded, enabled, blocked,
          cipher_buys, cipher_sells, cipher_lp_add, cipher_lp_remove, cipher_threshold,
          track_other_pools, other_lp_add, other_lp_remove, other_lp_threshold,
          other_buys, other_sells, other_threshold,
          wallet_alerts, new_pool_alerts, lock_alerts, reward_alerts,
          close_pool_alerts, protocol_fee_alerts, admin_alerts,
          snoozed_until, quiet_start, quiet_end, daily_digest,
          stats, today_stats, portfolio, my_wallet, created_at, last_active
        ) VALUES (
          @chatId, @onboarded, @enabled, @blocked,
          @cipherBuys, @cipherSells, @cipherLpAdd, @cipherLpRemove, @cipherThreshold,
          @trackOtherPools, @otherLpAdd, @otherLpRemove, @otherLpThreshold,
          @otherBuys, @otherSells, @otherThreshold,
          @walletAlerts, @newPoolAlerts, @lockAlerts, @rewardAlerts,
          @closePoolAlerts, @protocolFeeAlerts, @adminAlerts,
          @snoozedUntil, @quietStart, @quietEnd, @dailyDigest,
          @stats, @todayStats, @portfolio, @myWallet, @createdAt, @lastActive
        )
        ON CONFLICT(chat_id) DO UPDATE SET
          onboarded=excluded.onboarded, enabled=excluded.enabled, blocked=excluded.blocked,
          cipher_buys=excluded.cipher_buys, cipher_sells=excluded.cipher_sells,
          cipher_lp_add=excluded.cipher_lp_add, cipher_lp_remove=excluded.cipher_lp_remove,
          cipher_threshold=excluded.cipher_threshold,
          track_other_pools=excluded.track_other_pools,
          other_lp_add=excluded.other_lp_add, other_lp_remove=excluded.other_lp_remove,
          other_lp_threshold=excluded.other_lp_threshold,
          other_buys=excluded.other_buys, other_sells=excluded.other_sells,
          other_threshold=excluded.other_threshold,
          wallet_alerts=excluded.wallet_alerts,
          new_pool_alerts=excluded.new_pool_alerts, lock_alerts=excluded.lock_alerts,
          reward_alerts=excluded.reward_alerts,
          close_pool_alerts=excluded.close_pool_alerts,
          protocol_fee_alerts=excluded.protocol_fee_alerts,
          admin_alerts=excluded.admin_alerts,
          snoozed_until=excluded.snoozed_until,
          quiet_start=excluded.quiet_start, quiet_end=excluded.quiet_end,
          daily_digest=excluded.daily_digest,
          stats=excluded.stats, today_stats=excluded.today_stats,
          portfolio=excluded.portfolio, my_wallet=excluded.my_wallet,
          last_active=excluded.last_active
      `);

      stmt.run({
        chatId: user.chatId,
        onboarded: user.onboarded ? 1 : 0,
        enabled: user.enabled ? 1 : 0,
        blocked: user.blocked ? 1 : 0,
        cipherBuys: user.cipherBuys ? 1 : 0,
        cipherSells: user.cipherSells ? 1 : 0,
        cipherLpAdd: user.cipherLpAdd ? 1 : 0,
        cipherLpRemove: user.cipherLpRemove ? 1 : 0,
        cipherThreshold: user.cipherThreshold ?? 100,
        trackOtherPools: user.trackOtherPools ? 1 : 0,
        otherLpAdd: user.otherLpAdd ? 1 : 0,
        otherLpRemove: user.otherLpRemove ? 1 : 0,
        otherLpThreshold: user.otherLpThreshold ?? 500,
        otherBuys: user.otherBuys ? 1 : 0,
        otherSells: user.otherSells ? 1 : 0,
        otherThreshold: user.otherThreshold ?? 500,
        walletAlerts: user.walletAlerts ? 1 : 0,
        newPoolAlerts: user.newPoolAlerts !== false ? 1 : 0,
        lockAlerts: user.lockAlerts !== false ? 1 : 0,
        rewardAlerts: user.rewardAlerts !== false ? 1 : 0,
        closePoolAlerts: user.closePoolAlerts !== false ? 1 : 0,
        protocolFeeAlerts: user.protocolFeeAlerts !== false ? 1 : 0,
        adminAlerts: user.adminAlerts !== false ? 1 : 0,
        snoozedUntil: user.snoozedUntil || 0,
        quietStart: user.quietStart,
        quietEnd: user.quietEnd,
        dailyDigest: user.dailyDigest ? 1 : 0,
        stats: JSON.stringify(user.stats || {}),
        todayStats: JSON.stringify(user.todayStats || {}),
        portfolio: JSON.stringify(user.portfolio || {}),
        myWallet: user.myWallet,
        createdAt: user.createdAt || Date.now(),
        lastActive: user.lastActive || 0,
      });

      // Sync portfolio wallets
      db.prepare('DELETE FROM portfolio_wallets WHERE chat_id = ?').run(user.chatId);
      const insertPW = db.prepare('INSERT OR IGNORE INTO portfolio_wallets (chat_id, wallet, is_primary) VALUES (?, ?, ?)');
      (user.portfolioWallets || []).forEach((wallet, i) => {
        insertPW.run(user.chatId, wallet, i === 0 ? 1 : 0);
      });

      // Sync watchlist
      db.prepare('DELETE FROM watchlist WHERE chat_id = ?').run(user.chatId);
      const insertWL = db.prepare('INSERT OR IGNORE INTO watchlist (chat_id, pool_id) VALUES (?, ?)');
      for (const poolId of (user.watchlist || [])) {
        insertWL.run(user.chatId, poolId);
      }

      // Sync tracked tokens
      db.prepare('DELETE FROM tracked_tokens WHERE chat_id = ?').run(user.chatId);
      const insertTT = db.prepare('INSERT OR IGNORE INTO tracked_tokens (chat_id, mint) VALUES (?, ?)');
      for (const mint of (user.trackedTokens || [])) {
        insertTT.run(user.chatId, mint);
      }

      // Sync whale wallets
      db.prepare('DELETE FROM whale_wallets WHERE chat_id = ?').run(user.chatId);
      const insertWW = db.prepare('INSERT OR IGNORE INTO whale_wallets (chat_id, wallet) VALUES (?, ?)');
      for (const wallet of (user.wallets || [])) {
        insertWW.run(user.chatId, wallet);
      }
    });

    saveTransaction();
    log.debug(`💾 Saved user ${user.chatId}`);
  } catch (e) {
    log.error(`❌ Failed to save user ${user.chatId}:`, e.message);
  }
}

// Debounced save for frequent updates
let pendingSaves = new Set();
let saveTimeout = null;

function saveUserDebounced(user) {
  if (!user) return;
  pendingSaves.add(user.chatId);

  // Don't reset timer — prevents starvation from rapid saves
  if (saveTimeout) return;

  saveTimeout = setTimeout(() => {
    saveTimeout = null;
    // Snapshot and clear before saving — new saves during transaction start a new timer
    const batch = new Set(pendingSaves);
    pendingSaves.clear();
    try {
      const transaction = db.transaction(() => {
        for (const chatId of batch) {
          const u = users.get(chatId);
          if (u) saveUser(u);
        }
      });
      transaction();
      log.debug(`💾 Batch saved ${batch.size} users`);
    } catch (e) {
      log.error('Failed to batch save users:', e.message);
    }
  }, CONFIG.saveDebounceMs);
}

// Legacy compatibility - saves all users (for backward compatibility during transition)
function saveUsers() {
  if (!db) return;
  try {
    const transaction = db.transaction(() => {
      for (const user of users.values()) {
        saveUser(user);
      }
    });
    transaction();
    log.debug(`💾 Saved all ${users.size} users`);
  } catch (e) {
    log.error('❌ Failed to save users:', e.message);
  }
}

const saveUsersDebounced = debounce(saveUsers, CONFIG.saveDebounceMs);

function getUser(chatId) {
  return users.get(chatId);
}

function createUser(chatId) {
  const user = {
    chatId,
    onboarded: false,
    enabled: true,
    blocked: false,
    cipherBuys: true,
    cipherSells: true,
    cipherLpAdd: true,
    cipherLpRemove: true,
    cipherThreshold: 100,
    trackOtherPools: true,
    otherLpAdd: true,
    otherLpRemove: true,
    otherLpThreshold: 500,
    otherBuys: true,
    otherSells: true,
    otherThreshold: 500,
    watchlist: [],
    trackedTokens: [],
    wallets: [],
    walletAlerts: true,
    newPoolAlerts: true,
    lockAlerts: true,
    rewardAlerts: true,
    closePoolAlerts: true,
    protocolFeeAlerts: true,
    adminAlerts: true,
    snoozedUntil: 0,
    quietStart: null,
    quietEnd: null,
    dailyDigest: false,
    recentAlerts: [],
    todayStats: { trades: 0, lp: 0, wallet: 0, events: 0, lastReset: Date.now() },
    stats: { cipherBuys: 0, cipherSells: 0, cipherLp: 0, otherLp: 0, otherTrades: 0, walletAlerts: 0, events: 0, volume: 0 },
    createdAt: Date.now(),
    lastActive: Date.now(),
    portfolioWallets: [],
    myWallet: null,
    portfolio: {
      trades: [],
      lpPositions: [],
      tokens: [],
      totalVolume: 0,
      realizedPnl: 0,
      unrealizedPnl: 0,
      totalValue: 0,
      tradeCount: 0,
      buyCount: 0,
      sellCount: 0,
      solBalance: 0,
      tokenCount: 0,
      walletData: {},
      lastSync: 0,
    },
  };
  users.set(chatId, user);
  saveUser(user); // Immediate save for new users
  return user;
}

function updateUser(chatId, updates) {
  const user = users.get(chatId);
  if (user) {
    Object.assign(user, updates);
    saveUserDebounced(user);
  }
  return user;
}

function addRecentAlert(chatId, alert) {
  const user = users.get(chatId);
  if (!user) return;
  
  // Update in-memory
  user.recentAlerts = user.recentAlerts || [];
  user.recentAlerts.unshift({ ...alert, time: Date.now() });
  if (user.recentAlerts.length > CONFIG.maxRecentAlerts) {
    user.recentAlerts = user.recentAlerts.slice(0, CONFIG.maxRecentAlerts);
  }
  
  // Update today stats
  const today = new Date().toDateString();
  const lastReset = new Date(user.todayStats?.lastReset || 0).toDateString();
  if (today !== lastReset) {
    user.todayStats = { trades: 0, lp: 0, wallet: 0, events: 0, lastReset: Date.now() };
  }

  // Save to database
  if (db) {
    try {
      // Insert new alert
      db.prepare(`
        INSERT INTO recent_alerts (chat_id, type, pair, token, wallet, usd, is_buy, sig, time)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(chatId, alert.type || 'trade', alert.pair, alert.token, alert.wallet, alert.usd || 0, alert.isBuy ? 1 : 0, alert.sig, Date.now());
      
      // Clean up old alerts (keep only last N)
      db.prepare(`
        DELETE FROM recent_alerts WHERE chat_id = ? AND id NOT IN (
          SELECT id FROM recent_alerts WHERE chat_id = ? ORDER BY time DESC LIMIT ?
        )
      `).run(chatId, chatId, CONFIG.maxRecentAlerts);
    } catch (e) {
      log.debug('Failed to save recent alert:', e.message);
    }
  }
  
  saveUserDebounced(user);
}

function isUserSnoozed(user) {
  if (!user) return false;
  if (user.snoozedUntil && Date.now() < user.snoozedUntil) return true;
  if (user.quietStart !== null && user.quietEnd !== null) {
    const hour = new Date().getUTCHours();
    if (user.quietStart < user.quietEnd) {
      return hour >= user.quietStart && hour < user.quietEnd;
    } else {
      return hour >= user.quietStart || hour < user.quietEnd;
    }
  }
  return false;
}

function isQuietHoursActive(user) {
  if (!user || user.quietStart === null || user.quietEnd === null) return false;
  const hour = new Date().getUTCHours();
  if (user.quietStart < user.quietEnd) {
    return hour >= user.quietStart && hour < user.quietEnd;
  } else {
    return hour >= user.quietStart || hour < user.quietEnd;
  }
}


function getAllTrackedWallets() {
  const wallets = new Set();
  for (const user of users.values()) {
    if (user.wallets && user.walletAlerts && user.enabled && !user.blocked) {
      user.wallets.forEach(w => wallets.add(w));
    }
  }
  return [...wallets];
}

// ═══════════════════════════════════════════════════════════════════════════════
// POOLS
// ═══════════════════════════════════════════════════════════════════════════════
let pools = [];
let cipherPools = [];
let otherPools = [];
const poolMap = new Map();
let botStartTime = Date.now();
let orbitVolumes = { total24h: 0, pools: {} };
let lastTradesByPool = new Map(); // For deduplication in backup polling

const isCipherPool = (p) => {
  const base = p.baseMint || p.base;
  const quote = p.quoteMint || p.quote;
  return base === CONFIG.cipherMint || quote === CONFIG.cipherMint;
};

// Health check for Orbit API
async function checkOrbitHealth() {
  try {
    const res = await fetchWithRetry(ORBIT.health(), {}, 2);
    const data = await res.json();
    updateApiHealth('orbit', data?.status === 'ok' || data?.healthy === true || res.ok);
    return true;
  } catch (e) {
    updateApiHealth('orbit', false);
    return false;
  }
}

async function fetchPools() {
  try {
    const res = await fetchWithRetry(ORBIT.pools());
    const data = await res.json();
    const raw = Array.isArray(data) ? data : (data.pools || data.pairs || Object.values(data)[0] || []);
    
    pools = raw.map(p => ({
      ...p,
      pairName: formatPair(p.baseMint || p.base, p.quoteMint || p.quote),
      isCipher: isCipherPool(p),
    }));
    
    poolMap.clear();
    pools.forEach(p => poolMap.set(p.id, p));
    
    cipherPools = pools.filter(p => p.isCipher);
    otherPools = pools.filter(p => !p.isCipher);
    
    updateApiHealth('orbit', true);
    log.info(`📊 ${pools.length} pools (${cipherPools.length} CIPHER, ${otherPools.length} other)`);
  } catch (e) {
    updateApiHealth('orbit', false);
    log.error('❌ Pool fetch failed:', e.message);
  }
}

// Fetch volume data for dashboard
async function fetchVolumes() {
  try {
    const res = await fetchWithRetry(ORBIT.volumes('24h'));
    const data = await res.json();
    if (data) {
      orbitVolumes = {
        total24h: data.totalVolume || data.volume || 0,
        pools: data.pools || data.byPool || {},
        updatedAt: Date.now(),
      };
    }
  } catch (e) {
    // Volume fetch is optional, don't log errors
  }
}

// Backup: Poll trades API when WebSocket is down
async function pollTradesBackup() {
  if (orbitWs?.readyState === 1) return; // WebSocket is working
  
  log.debug('📡 Polling trades (WebSocket backup)...');
  
  for (const pool of pools.slice(0, 20)) { // Limit to top 20 pools
    try {
      const res = await fetchWithRetry(ORBIT.trades(pool.id, 20), {}, 1);
      const data = await res.json();
      const trades = data?.trades || data || [];
      
      const lastSig = lastTradesByPool.get(pool.id);
      
      for (const trade of trades) {
        const sig = trade.signature || trade.txId || trade.id;
        if (!sig || seenTxs.has(sig)) continue;
        if (lastSig && sig === lastSig) break; // Reached last processed trade
        
        seenTxs.add(sig);
        persistSeenTx(sig);
        const usd = estimateTradeUsd(trade, pool);
        const isBuy = trade.side === 'buy';

        broadcastTradeAlert({ pool, trade, usd, isBuy, sig });
      }
      
      if (trades[0]?.signature) {
        lastTradesByPool.set(pool.id, trades[0].signature);
      }
      
      // Small delay between pools
      await new Promise(r => setTimeout(r, 100));
    } catch (e) {}
  }
  
  cleanSeenTxs(); // Clean up old entries
}

function findPoolsByToken(mint) {
  return pools.filter(p => {
    const base = p.baseMint || p.base;
    const quote = p.quoteMint || p.quote;
    return base === mint || quote === mint;
  });
}

function searchPools(query) {
  const q = query.toLowerCase();
  return pools.filter(p => p.pairName.toLowerCase().includes(q)).slice(0, 10);
}

function isOrbitTransaction(accounts) {
  if (!accounts || !Array.isArray(accounts)) return false;
  return accounts.some(acc => acc === ORBIT_PROGRAM_ID || poolMap.has(acc));
}

// ═══════════════════════════════════════════════════════════════════════════════
// USD ESTIMATION (Using Jupiter Prices)
// ═══════════════════════════════════════════════════════════════════════════════
function estimateTradeUsd(trade, pool) {
  const base = pool.baseMint || pool.base;
  const quote = pool.quoteMint || pool.quote;
  const isBuy = trade.side === 'buy';
  
  // Try multiple field names for amounts (API might use different names)
  const getAmount = (trade, field) => {
    return trade[field] || trade[`${field}Amount`] || trade[`amount_${field}`] || 0;
  };
  
  const amountIn = parseFloat(getAmount(trade, 'amountIn') || trade.in || trade.inputAmount || 0);
  const amountOut = parseFloat(getAmount(trade, 'amountOut') || trade.out || trade.outputAmount || 0);
  
  // If API provides USD value directly, use it (most reliable)
  if (trade.usdValue && trade.usdValue > 0) {
    return parseFloat(trade.usdValue);
  }
  if (trade.valueUsd && trade.valueUsd > 0) {
    return parseFloat(trade.valueUsd);
  }
  if (trade.value && trade.value > 0 && trade.value < 1e9) { // Sanity check
    return parseFloat(trade.value);
  }
  
  // Try to get USD from quote side first (usually USDC/USDT/SOL)
  const quotePrice = getPrice(quote);
  if (quotePrice && quotePrice > 0) {
    const amt = isBuy ? amountIn : amountOut;
    if (amt > 0) {
      const decimals = getDecimals(quote);
      const quoteAmount = amt / Math.pow(10, decimals);
      const usd = quoteAmount * quotePrice;
      
      // Sanity check - if USD seems too high, might be decimal issue
      if (usd > 0 && usd < 100_000_000) { // Max $100M sanity check
        return usd;
      }
    }
  }
  
  // Try base side (for CIPHER, use CIPHER price)
  const basePrice = getPrice(base);
  if (basePrice && basePrice > 0) {
    const amt = isBuy ? amountOut : amountIn;
    if (amt > 0) {
      const decimals = getDecimals(base);
      const baseAmount = amt / Math.pow(10, decimals);
      const usd = baseAmount * basePrice;
      
      if (usd > 0 && usd < 100_000_000) {
        return usd;
      }
    }
  }
  
  // Fallback: use pool price if available
  if (pool.price && pool.price > 0) {
    const baseAmt = isBuy ? amountOut : amountIn;
    if (baseAmt > 0) {
      const decimals = getDecimals(base);
      const baseAmount = baseAmt / Math.pow(10, decimals);
      const usd = baseAmount * pool.price;
      
      if (usd > 0 && usd < 100_000_000) {
        return usd;
      }
    }
  }
  
  // Log when we can't estimate (for debugging)
  log.warn(`⚠️ Could not estimate USD for trade: in=${amountIn}, out=${amountOut}, base=${base?.slice(0,8)}, quote=${quote?.slice(0,8)}`);
  
  return 0;
}

function estimateLpUsd(msg, pool) {
  // If API provides USD value, use it
  if (msg.usdValue) return parseFloat(msg.usdValue);
  if (msg.value) return parseFloat(msg.value);
  
  // Try to estimate from amounts
  const quote = pool.quoteMint || pool.quote;
  const quotePrice = getPrice(quote);
  
  if (quotePrice && msg.quoteAmount) {
    const decimals = getDecimals(quote);
    const quoteSide = (parseFloat(msg.quoteAmount) / Math.pow(10, decimals)) * quotePrice;
    // Add base side if available, otherwise estimate as quote-only (don't blindly 2x for DLMM single-sided deposits)
    const base = pool.baseMint || pool.base;
    const basePrice = getPrice(base);
    if (basePrice && msg.baseAmount) {
      const baseDecimals = getDecimals(base);
      const baseSide = (parseFloat(msg.baseAmount) / Math.pow(10, baseDecimals)) * basePrice;
      return quoteSide + baseSide;
    }
    return quoteSide;
  }
  
  return 0;
}

function estimateWalletTxUsd(tx) {
  let totalUsd = 0;
  
  // Native SOL transfers
  if (tx.nativeTransfers?.length > 0) {
    const solPrice = getSolPrice();
    if (solPrice) {
      const solAmount = tx.nativeTransfers.reduce((sum, t) => sum + Math.abs(t.amount || 0), 0) / 1e9;
      totalUsd += solAmount * solPrice;
    }
  }
  
  // Token transfers
  if (tx.tokenTransfers?.length > 0) {
    for (const transfer of tx.tokenTransfers) {
      const price = getPrice(transfer.mint);
      if (price) {
        const decimals = getDecimals(transfer.mint);
        const amount = Math.abs(transfer.tokenAmount || 0) / Math.pow(10, decimals);
        totalUsd += amount * price;
      }
    }
  }
  
  return totalUsd;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PORTFOLIO TRACKING
// ═══════════════════════════════════════════════════════════════════════════════

// Short-term balance cache (30 seconds) to prevent duplicate requests
const balanceCache = new Map();
const BALANCE_CACHE_TTL = 30 * 1000; // 30 seconds

// Fetch user's token balances from Helius
async function fetchWalletBalances(wallet) {
  if (!wallet || !isValidWallet(wallet)) return { tokens: [], nativeBalance: 0, totalTokenValue: 0 };
  
  // Check cache first
  const cached = balanceCache.get(wallet);
  if (cached && Date.now() - cached.timestamp < BALANCE_CACHE_TTL) {
    return cached.data;
  }
  
  try {
    let items = [];
    let nativeBalance = 0;
    
    // Try Helius SDK first (cleaner, better error handling)
    let sdkSucceeded = false;
    if (helius) {
      try {
        const response = await helius.rpc.getAssetsByOwner({
          ownerAddress: wallet,
          page: 1,
          limit: 100,
          displayOptions: { showFungible: true, showNativeBalance: true }
        });
        items = response.items || [];
        nativeBalance = response.nativeBalance?.lamports || 0;
        sdkSucceeded = true;
        log.debug(`Helius SDK: fetched ${items.length} assets for ${wallet.slice(0,8)}`);
      } catch (sdkErr) {
        log.debug('Helius SDK failed, trying HTTP fallback:', sdkErr.message);
        // Fall through to HTTP fallback below
      }
    }
    if (!sdkSucceeded) {
      // HTTP fallback if SDK not initialized
      if (heliusLimiter) await heliusLimiter.acquire();
      const res = await fetchWithRetry(HELIUS.rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getAssetsByOwner',
          params: {
            ownerAddress: wallet,
            page: 1,
            limit: 100,
            displayOptions: { showFungible: true, showNativeBalance: true }
          }
        })
      });
      
      const data = await res.json();
      items = data?.result?.items || [];
      nativeBalance = data?.result?.nativeBalance?.lamports || 0;
    }
    
    const solBalance = nativeBalance / 1e9;
    
    let totalTokenValue = 0;
    const tokens = items
      .filter(item => item.interface === 'FungibleToken' || item.interface === 'FungibleAsset')
      .map(item => {
        const balance = parseFloat(item.token_info?.balance || 0);
        const decimals = item.token_info?.decimals || 6;
        const uiBalance = balance / Math.pow(10, decimals);
        const pricePerToken = item.token_info?.price_info?.price_per_token || 0;
        const totalUsd = item.token_info?.price_info?.total_price || (uiBalance * pricePerToken);
        
        totalTokenValue += totalUsd;
        
        return {
          mint: item.id,
          symbol: item.content?.metadata?.symbol || getSymbol(item.id),
          name: item.content?.metadata?.name || '',
          balance: uiBalance,
          decimals,
          pricePerToken,
          totalUsd,
        };
      })
      .filter(t => t.balance > 0)
      .sort((a, b) => b.totalUsd - a.totalUsd);
    
    const result = { 
      tokens, 
      nativeBalance: solBalance, 
      totalTokenValue,
      solValueUsd: solBalance * (getSolPrice() || 0),
    };
    
    // Cache the result
    balanceCache.set(wallet, { data: result, timestamp: Date.now() });
    
    return result;
  } catch (e) {
    // Ultimate fallback: use direct Solana web3.js
    log.debug('All Helius methods failed, using direct RPC:', e.message);
    try {
      const solBal = await getSolBalance(wallet);
      const tokenAccounts = await getTokenAccounts(wallet);
      
      const tokens = tokenAccounts.map(t => ({
        mint: t.mint,
        symbol: getSymbol(t.mint),
        name: '',
        balance: t.balance,
        decimals: t.decimals,
        pricePerToken: getPrice(t.mint) || 0,
        totalUsd: t.balance * (getPrice(t.mint) || 0),
      })).sort((a, b) => b.totalUsd - a.totalUsd);
      
      const totalTokenValue = tokens.reduce((sum, t) => sum + t.totalUsd, 0);
      
      return {
        tokens,
        nativeBalance: solBal || 0,
        totalTokenValue,
        solValueUsd: (solBal || 0) * (getSolPrice() || 0),
      };
    } catch (fallbackErr) {
      log.error('Wallet balance fetch error:', fallbackErr.message);
      return { tokens: [], nativeBalance: 0, totalTokenValue: 0, solValueUsd: 0 };
    }
  }
}

// Fetch user's recent Orbit trades
async function fetchWalletOrbitTrades(wallet, limit = 50) {
  if (!wallet || !isValidWallet(wallet)) return [];
  
  try {
    let txs = [];
    
    // Try Helius SDK first (better parsed transactions)
    if (helius) {
      try {
        txs = await helius.parseTransactions({
          address: wallet,
          limit: limit,
        });
        log.debug(`Helius SDK: parsed ${txs.length} transactions for ${wallet.slice(0,8)}`);
      } catch (sdkErr) {
        log.debug('Helius SDK parseTransactions failed:', sdkErr.message);
      }
    }
    
    // Fallback to HTTP API
    if (txs.length === 0) {
      const res = await fetchWithRetry(`${HELIUS.api}/addresses/${wallet}/transactions?api-key=${CONFIG.heliusKey}&limit=${limit}`);
      txs = await res.json();
    }
    
    const orbitTrades = [];
    
    for (const tx of txs || []) {
      // Check if transaction involves an Orbit pool
      const accounts = tx.accountData?.map(a => a.account) || [];
      const involvedPool = accounts.find(acc => poolMap.has(acc));
      
      if (involvedPool) {
        const pool = poolMap.get(involvedPool);
        const isBuy = tx.type === 'SWAP' && tx.tokenTransfers?.some(t => t.toUserAccount === wallet);
        
        // Calculate USD value
        let usd = 0;
        if (tx.tokenTransfers?.length > 0) {
          for (const transfer of tx.tokenTransfers) {
            const price = getPrice(transfer.mint);
            if (price) {
              const decimals = getDecimals(transfer.mint);
              const amount = Math.abs(transfer.tokenAmount || 0) / Math.pow(10, decimals);
              usd += amount * price;
            }
          }
        }
        
        orbitTrades.push({
          sig: tx.signature,
          pool: pool?.pairName || shortAddr(involvedPool),
          poolId: involvedPool,
          side: isBuy ? 'buy' : 'sell',
          usd: usd / 2, // Divide by 2 since we're counting both sides
          timestamp: tx.timestamp * 1000,
          isCipher: pool?.isCipher || false,
        });
      }
    }
    
    return orbitTrades;
  } catch (e) {
    log.error('Trade history fetch error:', e.message);
    return [];
  }
}

// Identify LP tokens in wallet
async function fetchLpPositions(wallet) {
  if (!wallet || !isValidWallet(wallet)) return [];
  
  try {
    const { tokens } = await fetchWalletBalances(wallet);
    const lpPositions = [];
    
    // Check each token to see if it's an LP token for an Orbit pool
    for (const token of tokens) {
      if (!token || !token.mint) continue;
      
      // Skip if balance is effectively 0
      const balance = parseFloat(token.balance) || 0;
      if (balance <= 0) continue;
      
      // LP tokens typically have the pool address or specific naming
      const pool = poolMap.get(token.mint) || pools.find(p => 
        p.lpMint === token.mint || 
        p.lpToken === token.mint ||
        p.id === token.mint
      );
      
      // Check if this looks like an LP token
      const isLpToken = pool || 
        (token.symbol && (
          token.symbol.includes('LP') || 
          token.symbol.includes('-') ||
          token.symbol.includes('/') ||
          token.symbol.toUpperCase().includes('DLMM')
        )) ||
        (token.name && (
          token.name.toLowerCase().includes('liquidity') ||
          token.name.toLowerCase().includes('pool') ||
          token.name.toLowerCase().includes('lp token')
        ));
      
      if (isLpToken) {
        const decimals = parseInt(token.decimals) || 6;
        const pricePerToken = parseFloat(token.pricePerToken) || 0;
        const shares = balance;
        const valueUsd = parseFloat(token.totalUsd) || (shares * pricePerToken);
        
        if (valueUsd > 0.01) { // Filter dust
          lpPositions.push({
            mint: token.mint,
            pool: pool?.pairName || token.symbol || shortAddr(token.mint),
            poolId: pool?.id || token.mint,
            shares: shares,
            valueUsd: valueUsd,
            isCipher: pool?.isCipher || (token.symbol && token.symbol.toUpperCase().includes('CIPHER')) || false,
          });
        }
      }
    }
    
    // Sort by value
    lpPositions.sort((a, b) => (b.valueUsd || 0) - (a.valueUsd || 0));
    
    return lpPositions;
  } catch (e) {
    log.error('LP positions fetch error:', e.message);
    return [];
  }
}

// Calculate PnL from trade history
function calculatePnL(trades) {
  if (!trades || trades.length === 0) return { realized: 0, volume: 0, trades: 0 };
  
  const positions = new Map(); // poolId -> { totalBought, totalSold, avgBuyPrice }
  let realizedPnl = 0;
  let totalVolume = 0;
  
  // Sort by timestamp (oldest first)
  const sorted = [...trades].sort((a, b) => a.timestamp - b.timestamp);
  
  for (const trade of sorted) {
    totalVolume += trade.usd || 0;
    
    const pos = positions.get(trade.poolId) || { bought: 0, sold: 0, cost: 0 };
    
    if (trade.side === 'buy') {
      pos.bought += trade.usd || 0;
      pos.cost += trade.usd || 0;
    } else {
      pos.sold += trade.usd || 0;
      // Realized PnL: sell value - proportional cost basis of remaining position
      if (pos.cost > 0) {
        const proportion = Math.min(trade.usd / pos.cost, 1);
        const costBasis = pos.cost * proportion;
        realizedPnl += (trade.usd || 0) - costBasis;
        pos.cost -= costBasis;
      }
    }
    
    positions.set(trade.poolId, pos);
  }
  
  return {
    realized: realizedPnl,
    volume: totalVolume,
    trades: trades.length,
  };
}

// Track ongoing portfolio syncs to prevent duplicate requests
const pendingPortfolioSyncs = new Map(); // chatId -> Promise

// Sync portfolio data for a user (supports multiple wallets)
async function syncPortfolio(chatId) {
  // Deduplicate concurrent sync requests for same user
  if (pendingPortfolioSyncs.has(chatId)) {
    return pendingPortfolioSyncs.get(chatId);
  }
  
  const syncPromise = _syncPortfolioInternal(chatId);
  pendingPortfolioSyncs.set(chatId, syncPromise);
  
  try {
    return await syncPromise;
  } finally {
    pendingPortfolioSyncs.delete(chatId);
  }
}

async function _syncPortfolioInternal(chatId) {
  const user = getUser(chatId);
  
  // Get all portfolio wallets (support legacy myWallet and new portfolioWallets array)
  let walletList = user?.portfolioWallets || [];
  if (user?.myWallet && !walletList.includes(user.myWallet)) {
    walletList = [user.myWallet, ...walletList];
  }
  
  if (walletList.length === 0) return null;
  
  try {
    // Aggregate data from all wallets
    let allTrades = [];
    let allLpPositions = [];
    let allTokens = new Map(); // Aggregate tokens by mint
    let totalVolume = 0;
    let totalRealizedPnl = 0;
    let totalUnrealizedPnl = 0;
    let totalSolBalance = 0;
    let totalSolValue = 0;
    let totalTokenValue = 0;
    let buyCount = 0;
    let sellCount = 0;
    const walletData = {};
    
    // Fetch data for each wallet in parallel
    const walletPromises = walletList.map(async (wallet) => {
      const [trades, lpPositions, balances, birdeyeData] = await Promise.all([
        fetchWalletOrbitTrades(wallet, 50),
        fetchLpPositions(wallet),
        fetchWalletBalances(wallet),
        fetchBirdeyeWalletData(wallet),
      ]);
      
      const pnlData = calculatePnL(trades);
      
      // Calculate wallet value from balances (most accurate)
      const solValue = balances.solValueUsd || (balances.nativeBalance * (getSolPrice() || 0));
      const tokenValue = balances.totalTokenValue || 0;
      const lpValue = lpPositions.reduce((sum, p) => sum + (p.valueUsd || 0), 0);
      const walletValue = solValue + tokenValue + lpValue;
      
      // Use Birdeye PnL if available, otherwise use calculated
      const walletPnl = birdeyeData?.totalPnl ?? pnlData.realized;
      const walletUnrealized = birdeyeData?.unrealizedPnl || 0;
      
      // Count buys and sells
      const buys = trades.filter(t => t.side === 'buy').length;
      const sells = trades.filter(t => t.side === 'sell').length;
      
      return {
        wallet,
        trades: trades.map(t => ({ ...t, wallet })),
        lpPositions: lpPositions.map(p => ({ ...p, wallet })),
        tokens: balances.tokens || [],
        volume: pnlData.volume,
        realizedPnl: walletPnl,
        unrealizedPnl: walletUnrealized,
        value: walletValue,
        solBalance: balances.nativeBalance,
        solValue,
        tokenValue,
        lpValue,
        tokenCount: balances.tokens?.length || 0,
        tradeCount: pnlData.trades,
        buyCount: buys,
        sellCount: sells,
      };
    });
    
    const settledResults = await Promise.allSettled(walletPromises);
    const results = settledResults
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value);

    if (results.length === 0 && settledResults.length > 0) {
      log.warn(`⚠️ All ${settledResults.length} wallet syncs failed`);
    }

    // Aggregate results
    for (const result of results) {
      allTrades.push(...result.trades);
      allLpPositions.push(...result.lpPositions);
      totalVolume += result.volume;
      totalRealizedPnl += result.realizedPnl;
      totalUnrealizedPnl += result.unrealizedPnl;
      totalSolBalance += result.solBalance;
      totalSolValue += result.solValue;
      totalTokenValue += result.tokenValue;
      buyCount += result.buyCount;
      sellCount += result.sellCount;
      
      // Aggregate tokens across wallets
      for (const token of result.tokens) {
        if (allTokens.has(token.mint)) {
          const existing = allTokens.get(token.mint);
          existing.balance += token.balance;
          existing.totalUsd += token.totalUsd;
        } else {
          allTokens.set(token.mint, { ...token });
        }
      }
      
      // Store per-wallet data for breakdown
      walletData[result.wallet] = {
        value: result.value,
        solBalance: result.solBalance,
        solValue: result.solValue,
        tokenValue: result.tokenValue,
        lpValue: result.lpValue,
        pnl: result.realizedPnl,
        unrealized: result.unrealizedPnl,
        volume: result.volume,
        trades: result.tradeCount,
        buys: result.buyCount,
        sells: result.sellCount,
        tokenCount: result.tokenCount,
      };
    }
    
    // Sort trades by timestamp (most recent first)
    allTrades.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    
    // Fetch staked CIPHER positions for all wallets (parallel for performance)
    let totalScipherBalance = 0;
    let totalOriginalStake = 0;
    let totalStakedValue = 0;
    const stakedPositions = [];
    
    const stakedResults = await Promise.all(
      walletList.map(wallet => fetchUserStakedCipher(wallet).catch(() => null))
    );
    
    for (let i = 0; i < walletList.length; i++) {
      const stakedData = stakedResults[i];
      if (stakedData && stakedData.scipherBalance > 0) {
        const originalStake = stakedData.originalStake || stakedData.vaultShare || 0;
        stakedPositions.push({
          wallet: walletList[i],
          scipherBalance: stakedData.scipherBalance,
          originalStake: originalStake,
          valueUsd: stakedData.stakedValueUsd,
          multiplier: stakedData.multiplier || null,
          source: stakedData.source,
        });
        totalScipherBalance += stakedData.scipherBalance;
        totalOriginalStake += originalStake;
        totalStakedValue += stakedData.stakedValueUsd;
      }
    }
    
    // Calculate LP value
    const totalLpValue = allLpPositions.reduce((sum, p) => sum + (p.valueUsd || 0), 0);
    
    // Sort tokens by value for display
    const sortedTokens = [...allTokens.values()].sort((a, b) => b.totalUsd - a.totalUsd);
    
    // Calculate total value
    const totalValue = totalSolValue + totalTokenValue + totalLpValue + totalStakedValue;
    
    user.portfolio = {
      // Trades
      trades: allTrades.slice(0, 100),
      tradeCount: allTrades.length,
      buyCount,
      sellCount,
      totalVolume,
      
      // Balances
      solBalance: totalSolBalance,
      solValue: totalSolValue,
      tokens: sortedTokens.slice(0, 20), // Top 20 tokens
      tokenCount: sortedTokens.length,
      totalTokenValue,
      
      // LP
      lpPositions: allLpPositions,
      lpValue: totalLpValue,
      
      // Staking
      stakedPositions,
      totalScipherBalance,
      totalStakedCipher: totalOriginalStake,
      totalStakedValue,
      
      // PnL
      realizedPnl: totalRealizedPnl,
      unrealizedPnl: totalUnrealizedPnl,
      
      // Totals
      totalValue,
      
      // Meta
      walletData,
      walletCount: walletList.length,
      lastSync: Date.now(),
    };
    
    // Update portfolioWallets to ensure consistency
    user.portfolioWallets = walletList;
    user.myWallet = walletList[0] || null; // Keep first wallet as legacy
    
    saveUsersDebounced();  // Debounced for performance
    return user.portfolio;
  } catch (e) {
    log.error('Portfolio sync error:', e.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CIPHER TOKEN SUPPLY & STAKING DATA
// ═══════════════════════════════════════════════════════════════════════════════

// Cache for CIPHER supply data (refresh every 5 minutes)
let cipherSupplyCache = { data: null, timestamp: 0 };
const CIPHER_SUPPLY_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// CIPHER tokenomics constants
const CIPHER_TOTAL_SUPPLY = 1_000_000_000; // 1 billion

// Streamflow program ID for vesting
const STREAMFLOW_PROGRAM = 'strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m';

// Fetch all CIPHER tokens held by Streamflow vesting contracts
async function fetchStreamflowLockedAmount() {
  try {
    // Get largest token accounts for CIPHER - vesting contracts will be among top holders
    const res = await fetchWithRetry(HELIUS.rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getTokenLargestAccounts',
        params: [MINTS.CIPHER],
      }),
    });
    
    const data = await res.json();
    if (!data?.result?.value) return null;
    
    // Get account info to check which are owned by Streamflow
    const accounts = data.result.value;
    let streamflowLocked = 0;
    
    // Check each large holder to see if it's a Streamflow escrow (throttled to avoid rate limits)
    for (let i = 0; i < Math.min(accounts.length, 20); i++) {
      const account = accounts[i];
      try {
        const infoRes = await fetchWithRetry(HELIUS.rpc, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getAccountInfo',
            params: [account.address, { encoding: 'jsonParsed' }],
          }),
        });

        const infoData = await infoRes.json();
        const owner = infoData?.result?.value?.owner;

        // Check if owned by Streamflow program or known vesting contract
        if (owner === STREAMFLOW_PROGRAM || owner === MINTS.CIPHER_VESTING) {
          streamflowLocked += parseFloat(account.uiAmountString || account.uiAmount || 0);
        }
      } catch (e) {
        // Skip this account on error
      }
      // Throttle: 100ms between calls to avoid burning Helius rate limit
      if (i < 19) await new Promise(r => setTimeout(r, 100));
    }
    
    return streamflowLocked;
  } catch (e) {
    log.error('Streamflow locked fetch error:', e.message);
    return null;
  }
}

// Fetch token supply from Solana RPC
async function fetchTokenSupply(mint) {
  try {
    const res = await fetchWithRetry(HELIUS.rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getTokenSupply',
        params: [mint],
      }),
    });
    const data = await res.json();
    if (data?.result?.value) {
      return {
        amount: parseFloat(data.result.value.amount),
        decimals: data.result.value.decimals,
        uiAmount: parseFloat(data.result.value.uiAmountString || data.result.value.uiAmount),
      };
    }
    return null;
  } catch (e) {
    log.error('Token supply fetch error:', e.message);
    return null;
  }
}

// Cache for global staking data
let stakedCipherCache = { data: null, timestamp: 0 };
const STAKED_CIPHER_CACHE_TTL = 60000; // 1 minute

// Fetch total staked CIPHER data from stake pool
async function fetchStakedCipher() {
  // Return cached data if fresh
  if (stakedCipherCache.data && Date.now() - stakedCipherCache.timestamp < STAKED_CIPHER_CACHE_TTL) {
    return stakedCipherCache.data;
  }
  
  try {
    // Fetch both vault balance and receipt token supply in parallel
    const [vaultRes, receiptRes] = await Promise.all([
      // Vault: Actual CIPHER staked (using stake pool address as token account)
      fetchWithRetry(HELIUS.rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getTokenAccountBalance',
          params: [MINTS.CIPHER_STAKE_POOL],
        }),
      }),
      // Receipt token supply (sCIPHER)
      fetchWithRetry(HELIUS.rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getTokenSupply',
          params: [MINTS.CIPHER_STAKING_TOKEN],
        }),
      }),
    ]);
    
    const vaultData = await vaultRes.json();
    const receiptData = await receiptRes.json();
    
    const vaultBalance = parseFloat(vaultData?.result?.value?.uiAmountString || vaultData?.result?.value?.uiAmount || 0);
    const receiptSupply = parseFloat(receiptData?.result?.value?.uiAmountString || receiptData?.result?.value?.uiAmount || 0);
    
    const result = {
      stakedAmount: vaultBalance,      // Actual CIPHER in vault
      receiptSupply: receiptSupply,    // Total sCIPHER supply
    };
    
    // Cache the result
    stakedCipherCache = { data: result, timestamp: Date.now() };
    log.debug(`Staking pool: ${vaultBalance.toFixed(0)} CIPHER staked, ${receiptSupply.toFixed(0)} sCIPHER supply`);
    
    return result;
  } catch (e) {
    log.error('Staked CIPHER fetch error:', e.message);
    return stakedCipherCache.data || { stakedAmount: 0, receiptSupply: 0 };
  }
}

// Find user's original staked CIPHER by analyzing token balance changes
// Cache results per wallet to avoid excessive API calls
const userStakeCache = new Map(); // wallet -> { originalStake, timestamp }
const USER_STAKE_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

async function fetchUserStakeFromHistory(walletAddress) {
  try {
    // Check cache first
    const cached = userStakeCache.get(walletAddress);
    if (cached && Date.now() - cached.timestamp < USER_STAKE_CACHE_TTL) {
      return cached.originalStake;
    }
    
    // Use Helius Enhanced Transactions API to get parsed transaction history
    const res = await fetchWithRetry(
      `https://api-mainnet.helius-rpc.com/v0/addresses/${walletAddress}/transactions?api-key=${CONFIG.heliusKey}`,
      { method: 'GET' }
    );
    
    const transactions = await res.json();
    
    // Check for API errors or empty response
    if (!transactions || !Array.isArray(transactions) || transactions.length === 0) {
      return null;
    }
    
    // Check for error response
    if (transactions.error) {
      log.error('Helius API error:', transactions.error);
      return null;
    }
    
    let totalOriginalStake = 0;
    
    // Look through transactions for staking activity
    for (const tx of transactions) {
      if (!tx) continue;
      
      // Check if this transaction involves token transfers with CIPHER and sCIPHER
      const tokenTransfers = tx.tokenTransfers || [];
      
      let cipherSent = 0;
      let scipherReceived = 0;
      
      for (const transfer of tokenTransfers) {
        if (!transfer) continue;
        
        // CIPHER sent FROM user (to stake pool)
        if (transfer.mint === MINTS.CIPHER && 
            transfer.fromUserAccount === walletAddress) {
          cipherSent += parseFloat(transfer.tokenAmount) || 0;
        }
        
        // sCIPHER received BY user (minted)
        if (transfer.mint === MINTS.CIPHER_STAKING_TOKEN && 
            transfer.toUserAccount === walletAddress) {
          scipherReceived += parseFloat(transfer.tokenAmount) || 0;
        }
      }
      
      // Also check token balance changes for mints
      const accountData = tx.accountData || [];
      for (const account of accountData) {
        if (!account) continue;
        
        const tokenChanges = account.tokenBalanceChanges || [];
        for (const change of tokenChanges) {
          if (!change) continue;
          
          // sCIPHER minted to user
          if (change.mint === MINTS.CIPHER_STAKING_TOKEN && 
              change.userAccount === walletAddress) {
            const amount = parseFloat(change.rawTokenAmount?.tokenAmount || 0);
            const decimals = parseInt(change.rawTokenAmount?.decimals) || 9;
            if (amount > 0) {
              scipherReceived = Math.max(scipherReceived, amount / Math.pow(10, decimals));
            }
          }
          
          // CIPHER sent from user
          if (change.mint === MINTS.CIPHER && 
              change.userAccount === walletAddress) {
            const amount = parseFloat(change.rawTokenAmount?.tokenAmount || 0);
            const decimals = parseInt(change.rawTokenAmount?.decimals) || 9;
            if (amount < 0) { // Negative = sent
              cipherSent = Math.max(cipherSent, Math.abs(amount) / Math.pow(10, decimals));
            }
          }
        }
      }
      
      // If we found both CIPHER sent AND sCIPHER received, this is a stake transaction
      if (cipherSent > 0 && scipherReceived > 0) {
        totalOriginalStake += cipherSent;
      }
    }
    
    // Cache the result
    userStakeCache.set(walletAddress, { originalStake: totalOriginalStake > 0 ? totalOriginalStake : null, timestamp: Date.now() });
    
    return totalOriginalStake > 0 ? totalOriginalStake : null;
  } catch (e) {
    log.error('Stake history fetch error:', e.message);
    return null;
  }
}

// Fetch user's staked CIPHER position
async function fetchUserStakedCipher(walletAddress) {
  try {
    let userScipherBalance = 0;
    
    // Try Helius SDK first
    if (helius) {
      try {
        const response = await helius.rpc.getAssetsByOwner({
          ownerAddress: walletAddress,
          page: 1,
          limit: 50,
          displayOptions: { showFungible: true }
        });
        
        const scipherToken = (response.items || []).find(
          item => item.id === MINTS.CIPHER_STAKING_TOKEN
        );
        
        if (scipherToken) {
          const balance = parseFloat(scipherToken.token_info?.balance || 0);
          const decimals = scipherToken.token_info?.decimals || 9;
          userScipherBalance = balance / Math.pow(10, decimals);
        }
        log.debug(`Helius SDK: sCIPHER balance for ${walletAddress.slice(0,8)}: ${userScipherBalance}`);
      } catch (sdkErr) {
        log.debug('Helius SDK failed for sCIPHER, trying RPC:', sdkErr.message);
      }
    }
    
    // Fallback to direct RPC
    if (userScipherBalance === 0) {
      try {
        const conn = await getConnection();
        const pubkey = new PublicKey(walletAddress);
        const mintPubkey = new PublicKey(MINTS.CIPHER_STAKING_TOKEN);
        
        const tokenAccounts = await conn.getParsedTokenAccountsByOwner(pubkey, { mint: mintPubkey });
        
        for (const account of tokenAccounts.value) {
          const balance = account.account?.data?.parsed?.info?.tokenAmount?.uiAmount;
          if (balance) {
            userScipherBalance += parseFloat(balance);
          }
        }
        log.debug(`Direct RPC: sCIPHER balance for ${walletAddress.slice(0,8)}: ${userScipherBalance}`);
      } catch (rpcErr) {
        // Final fallback to HTTP
        const scipherRes = await fetchWithRetry(HELIUS.rpc, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getTokenAccountsByOwner',
            params: [
              walletAddress,
              { mint: MINTS.CIPHER_STAKING_TOKEN },
              { encoding: 'jsonParsed' }
            ],
          }),
        });
        
        const scipherData = await scipherRes.json();
        
        if (scipherData?.result?.value) {
          for (const account of scipherData.result.value) {
            const balance = account.account?.data?.parsed?.info?.tokenAmount?.uiAmount;
            if (balance) {
              userScipherBalance += parseFloat(balance);
            }
          }
        }
      }
    }
    
    if (userScipherBalance === 0) {
      return null;
    }
    
    // Try to find original stake from transaction history
    const originalStake = await fetchUserStakeFromHistory(walletAddress);
    
    // Get CIPHER price - try multiple sources
    let cipherPrice = await getCipherPrice();
    
    if (originalStake && originalStake > 0) {
      // We found the original staked amount from history!
      return {
        scipherBalance: userScipherBalance,
        originalStake: originalStake,
        stakedValueUsd: originalStake * cipherPrice,
        multiplier: userScipherBalance / originalStake,
        source: 'history',
      };
    }
    
    // Fallback: Calculate vault share if history lookup failed
    const stakingData = await fetchStakedCipher();
    const totalScipherSupply = stakingData.receiptSupply || 1;
    const totalVaultCipher = stakingData.stakedAmount || 0;
    
    const userShare = userScipherBalance / totalScipherSupply;
    const userVaultCipher = userShare * totalVaultCipher;
    const vaultShareValue = userVaultCipher * cipherPrice;
    
    log.debug(`Staked CIPHER calc: sCIPHER=${userScipherBalance}, share=${(userShare*100).toFixed(2)}%, vault=${userVaultCipher}, price=$${cipherPrice}, value=$${vaultShareValue}`);
    
    return {
      scipherBalance: userScipherBalance,
      originalStake: null,  // Unknown
      vaultShare: userVaultCipher,
      stakedValueUsd: vaultShareValue,
      source: 'vault_share',
    };
  } catch (e) {
    log.error('User staked CIPHER fetch error:', e.message);
    return null;
  }
}

// Fetch comprehensive CIPHER supply data
async function fetchCipherSupplyData() {
  // Check cache
  if (cipherSupplyCache.data && Date.now() - cipherSupplyCache.timestamp < CIPHER_SUPPLY_CACHE_TTL) {
    return cipherSupplyCache.data;
  }
  
  try {
    // Fetch all data in parallel
    const [supplyData, streamflowLocked, stakingData] = await Promise.all([
      fetchTokenSupply(MINTS.CIPHER),
      fetchStreamflowLockedAmount(),
      fetchStakedCipher(),
    ]);
    
    const totalSupply = supplyData?.uiAmount || CIPHER_TOTAL_SUPPLY;
    const staked = stakingData?.stakedAmount || 0;
    const receiptSupply = stakingData?.receiptSupply || 0;
    
    // Get locked amount from on-chain data or use fallback
    let locked = streamflowLocked || 0;
    
    // If on-chain fetch failed or returned 0, use known percentage as fallback
    // This percentage should be updated periodically based on actual vesting schedule
    if (locked === 0 || locked < totalSupply * 0.5) {
      // Fallback: Calculate based on known vesting schedule
      // As of the screenshot: 80.02% locked
      locked = totalSupply * 0.8002;
    }
    
    // Circulating = Total - Locked (vesting that hasn't unlocked yet)
    const circulating = totalSupply - locked;
    
    const result = {
      totalSupply,
      lockedVesting: locked,
      circulatingSupply: circulating,
      stakedSupply: staked,
      receiptTokenSupply: receiptSupply,
      // Percentages (guard against division by zero)
      lockedPercent: totalSupply > 0 ? (locked / totalSupply * 100) : 0,
      stakedPercent: totalSupply > 0 ? (staked / totalSupply * 100) : 0,
      circulatingPercent: totalSupply > 0 ? (circulating / totalSupply * 100) : 0,
    };
    
    // Update cache
    cipherSupplyCache = { data: result, timestamp: Date.now() };
    
    return result;
  } catch (e) {
    log.error('CIPHER supply data error:', e.message);
    
    // Return fallback data based on known values from Streamflow dashboard
    const fallback = {
      totalSupply: CIPHER_TOTAL_SUPPLY,
      lockedVesting: 800_200_000, // 80.02%
      unlockedVesting: 199_800_000, // 19.98%
      stakedSupply: 70_600_000,   // 7.06%
      circulatingSupply: 199_800_000, // 19.98%
      lockedPercent: 80.02,
      stakedPercent: 7.06,
      circulatingPercent: 19.98,
    };
    
    cipherSupplyCache = { data: fallback, timestamp: Date.now() };
    return fallback;
  }
}

// Format large numbers with K/M/B suffix (uses numeral)
function fmtSupply(num) {
  return formatNumber(num, 2);
}

// Compact format for volumes (e.g. $1.2M)
function fmtCompact(num) {
  if (!num || isNaN(num)) return '$0';
  if (num >= 1e9) return `$${(num / 1e9).toFixed(1)}B`;
  if (num >= 1e6) return `$${(num / 1e6).toFixed(1)}M`;
  if (num >= 1e3) return `$${(num / 1e3).toFixed(1)}K`;
  return `$${num.toFixed(0)}`;
}

// Get pools sorted by volume, TVL, or trades
function getSortedPools(sortBy = 'volume') {
  const poolsWithData = pools.map(p => ({
    ...p,
    volume24h: orbitVolumes.pools?.[p.id]?.volume24h || 0,
    tvl: p.tvl || p.liquidity || 0,
    trades24h: orbitVolumes.pools?.[p.id]?.trades24h || 0,
  }));
  
  switch (sortBy) {
    case 'tvl':
      return poolsWithData.sort((a, b) => b.tvl - a.tvl);
    case 'trades':
      return poolsWithData.sort((a, b) => b.trades24h - a.trades24h);
    case 'volume':
    default:
      return poolsWithData.sort((a, b) => b.volume24h - a.volume24h);
  }
}

// Get top N pools by 24h volume
function getTopPoolsByVolume(n = 10) {
  return getSortedPools('volume').slice(0, n);
}

// Get pool by ID
function getPoolById(poolId) {
  return poolMap.get(poolId) || pools.find(p => p.id === poolId);
}

// Get pools added in the last N hours
function getNewPools(hours = 48) {
  const cutoff = Date.now() - (hours * 60 * 60 * 1000);
  return pools
    .filter(p => p.createdAt && p.createdAt > cutoff)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

// Get human-readable pool age
function getPoolAge(pool) {
  if (!pool?.createdAt) return 'Unknown';
  const hours = Math.floor((Date.now() - pool.createdAt) / (60 * 60 * 1000));
  if (hours < 1) return 'Just now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// BIRDEYE ENHANCED DATA
// ═══════════════════════════════════════════════════════════════════════════════

// Fetch wallet data from Birdeye (PnL, holdings, total value)
async function fetchBirdeyeWalletData(wallet) {
  if (!wallet) return null;
  
  try {
    const res = await birdeyeFetch(BIRDEYE.walletNetWorth(wallet));
    const data = await res.json();
    
    if (!data?.success || !data?.data) {
      updateApiHealth('birdeye', false);
      return null;
    }
    
    updateApiHealth('birdeye', true);
    
    const items = data.data.items || [];
    let totalValue = 0;
    let totalPnl = 0;
    let unrealizedPnl = 0;
    
    for (const item of items) {
      const value = item.valueUsd || 0;
      totalValue += value;
      
      // Calculate PnL from cost basis if available
      if (item.priceInfo?.pnl) {
        totalPnl += item.priceInfo.pnl;
      }
      if (item.priceInfo?.unrealizedPnl) {
        unrealizedPnl += item.priceInfo.unrealizedPnl;
      }
    }
    
    return {
      totalValue,
      totalPnl,
      unrealizedPnl,
      tokenCount: items.length,
      tokens: items.slice(0, 20).map(t => ({
        mint: t.address,
        symbol: t.symbol,
        balance: t.uiAmount,
        valueUsd: t.valueUsd,
        price: t.priceUsd,
      })),
    };
  } catch (e) {
    log.error('Birdeye wallet fetch error:', e.message);
    updateApiHealth('birdeye', false);
    return null;
  }
}

// Fetch enhanced token overview from Birdeye
async function fetchTokenOverview(mint) {
  if (!mint) return null;
  
  try {
    const res = await birdeyeFetch(BIRDEYE.overview(mint));
    const data = await res.json();
    
    if (!data?.success || !data?.data) {
      return null;
    }
    
    updateApiHealth('birdeye', true);
    const d = data.data;
    
    return {
      price: d.price,
      priceChange24h: d.priceChange24hPercent,
      priceChange1h: d.priceChange1hPercent,
      volume24h: d.v24hUSD,
      volume24hChange: d.v24hChangePercent,
      liquidity: d.liquidity,
      mc: d.mc,
      fdv: d.fdv,
      holders: d.holder,
      trades24h: d.trade24h,
      buy24h: d.buy24h,
      sell24h: d.sell24h,
      uniqueWallets24h: d.uniqueWallet24h,
      lastTradeTime: d.lastTradeUnixTime,
    };
  } catch (e) {
    log.error('Token overview fetch error:', e.message);
    return null;
  }
}

// Fetch token security info from Birdeye
async function fetchTokenSecurity(mint) {
  if (!mint) return null;
  
  try {
    const res = await birdeyeFetch(BIRDEYE.security(mint));
    const data = await res.json();
    
    if (!data?.success || !data?.data) {
      return null;
    }
    
    const d = data.data;
    return {
      isHoneypot: d.isHoneypot,
      top10HolderPercent: d.top10HolderPercent,
      creatorPercent: d.creatorPercent,
      ownerPercent: d.ownerPercent,
      isMintable: d.isMintable,
      isFreezable: d.isFreezable,
      creationTime: d.creationTime,
      creatorAddress: d.creatorAddress,
    };
  } catch (e) {
    return null;
  }
}

// Cache for token overviews (don't fetch too often)
const tokenOverviewCache = new Map();
const TOKEN_OVERVIEW_TTL = 60000; // 1 minute cache

async function getTokenOverview(mint) {
  const cached = tokenOverviewCache.get(mint);
  if (cached && Date.now() - cached.fetchedAt < TOKEN_OVERVIEW_TTL) {
    return cached.data;
  }
  
  const data = await fetchTokenOverview(mint);
  if (data) {
    tokenOverviewCache.set(mint, { data, fetchedAt: Date.now() });
  }
  return data;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PNL LEADERBOARDS (ORBIT DLMM SPECIFIC)
// ═══════════════════════════════════════════════════════════════════════════════

// Cache for leaderboard data (expensive to compute)
const leaderboardCache = new BoundedCache(20, 300000); // 5 min TTL

// Fetch trades from Orbit and compute PnL leaderboard
async function fetchOrbitLeaderboard(poolId, limit = 10) {
  if (!poolId) return { traders: [], pool: null };
  
  const cacheKey = `leaderboard:${poolId}`;
  const cached = leaderboardCache.get(cacheKey);
  if (cached) return cached;
  
  try {
    const pool = poolMap.get(poolId);
    if (!pool) return { traders: [], pool: null };
    
    // Fetch recent trades from Orbit API
    const res = await fetchWithRetry(ORBIT.trades(poolId, 500)); // Get last 500 trades
    const data = await res.json();
    
    const trades = Array.isArray(data) ? data : (data.trades || data.items || []);
    
    if (trades.length === 0) {
      return { traders: [], pool };
    }
    
    // Aggregate trades by wallet
    const walletStats = new Map();
    
    for (const trade of trades) {
      const wallet = trade.wallet || trade.user || trade.owner || trade.maker || trade.taker;
      if (!wallet) continue;
      
      const isBuy = trade.side === 'buy' || trade.type === 'buy';
      const usd = parseFloat(trade.usd) || parseFloat(trade.amountUsd) || parseFloat(trade.volumeUsd) || 0;
      const baseAmount = parseFloat(trade.baseAmount) || parseFloat(trade.amount) || 0;
      const price = parseFloat(trade.price) || 0;
      
      if (!walletStats.has(wallet)) {
        walletStats.set(wallet, {
          wallet,
          buys: 0,
          sells: 0,
          buyVolume: 0,
          sellVolume: 0,
          buyAmount: 0,
          sellAmount: 0,
          totalTrades: 0,
          firstTrade: trade.timestamp || Date.now(),
          lastTrade: trade.timestamp || Date.now(),
        });
      }
      
      const stats = walletStats.get(wallet);
      stats.totalTrades++;
      
      if (isBuy) {
        stats.buys++;
        stats.buyVolume += usd;
        stats.buyAmount += baseAmount;
      } else {
        stats.sells++;
        stats.sellVolume += usd;
        stats.sellAmount += baseAmount;
      }
      
      if (trade.timestamp) {
        stats.lastTrade = Math.max(stats.lastTrade, trade.timestamp);
        stats.firstTrade = Math.min(stats.firstTrade, trade.timestamp);
      }
    }
    
    // Calculate PnL for each wallet
    const currentPrice = getPrice(pool.baseMint) || 0;
    
    const traders = [...walletStats.values()].map(stats => {
      // PnL: cost-basis-adjusted realized + unrealized
      const remainingTokens = stats.buyAmount - stats.sellAmount;
      const avgCostPerToken = stats.buyAmount > 0 ? stats.buyVolume / stats.buyAmount : 0;
      const soldCostBasis = stats.sellAmount * avgCostPerToken;
      const realizedPnl = stats.sellVolume - soldCostBasis;
      const remainingCostBasis = remainingTokens > 0 ? remainingTokens * avgCostPerToken : 0;
      const unrealizedValue = remainingTokens > 0 ? remainingTokens * currentPrice : 0;
      const totalPnl = realizedPnl + (unrealizedValue - remainingCostBasis);
      
      const totalVolume = stats.buyVolume + stats.sellVolume;
      const pnlPercent = stats.buyVolume > 0 ? (totalPnl / stats.buyVolume) * 100 : 0;
      
      return {
        wallet: stats.wallet,
        shortWallet: shortAddr(stats.wallet),
        pnl: totalPnl,
        pnlPercent: isFinite(pnlPercent) ? pnlPercent : 0,
        volume: totalVolume,
        trades: stats.totalTrades,
        buys: stats.buys,
        sells: stats.sells,
        buyVolume: stats.buyVolume,
        sellVolume: stats.sellVolume,
        holding: remainingTokens,
        holdingUsd: unrealizedValue,
      };
    })
    .filter(t => t.trades >= 2 && t.volume > 10) // Min 2 trades and $10 volume
    .sort((a, b) => b.pnl - a.pnl) // Sort by PnL
    .slice(0, limit)
    .map((t, i) => ({ ...t, rank: i + 1 }));
    
    const result = { traders, pool };
    leaderboardCache.set(cacheKey, result);
    
    return result;
  } catch (e) {
    log.error('Orbit leaderboard fetch error:', e.message);
    return { traders: [], pool: null };
  }
}

// Fetch leaderboard for a token (finds best Orbit pool)
async function fetchPnLLeaderboard(mintOrPoolId, limit = 10) {
  // Check if it's a pool ID
  if (poolMap.has(mintOrPoolId)) {
    return fetchOrbitLeaderboard(mintOrPoolId, limit);
  }
  
  // Find Orbit pools for this token
  const tokenPools = pools.filter(p => 
    p.baseMint === mintOrPoolId || 
    p.quoteMint === mintOrPoolId
  );
  
  if (tokenPools.length === 0) {
    // No Orbit pools for this token
    return { 
      traders: [], 
      pool: null,
      error: 'This token has no Orbit DLMM pools. Only Orbit pools are tracked.'
    };
  }
  
  // Use the pool with most activity (or first CIPHER pool)
  const pool = tokenPools.find(p => p.isCipher) || tokenPools[0];
  return fetchOrbitLeaderboard(pool.id, limit);
}

// Format PnL leaderboard message
function formatLeaderboardMessage(data) {
  if (data.error) {
    return `❌ *Not Available*\n\n${data.error}`;
  }
  
  if (!data.traders || data.traders.length === 0) {
    return `❌ *No leaderboard data*\n\nNo recent trading activity found for this Orbit pool.`;
  }
  
  const { traders, pool } = data;
  const symbol = pool?.pairName || 'POOL';
  
  let msg = `🏆 *ORBIT DLMM LEADERBOARD*\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `📊 *${escMd(symbol)}*`;
  if (pool) {
    const price = getPrice(pool.baseMint);
    if (price) msg += ` • ${fmtPrice(price)}`;
  }
  msg += `\n\n`;
  
  traders.forEach((t, i) => {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
    const pnlIcon = t.pnl >= 0 ? '🟢' : '🔴';
    const pnlStr = t.pnl >= 0 ? `+${fmt(t.pnl)}` : fmt(t.pnl);
    
    msg += `${medal} \`${t.shortWallet}\`\n`;
    msg += `   ${pnlIcon} *${pnlStr}*`;
    if (t.pnlPercent && isFinite(t.pnlPercent)) {
      msg += ` (${t.pnlPercent > 0 ? '+' : ''}${t.pnlPercent.toFixed(1)}%)`;
    }
    msg += `\n`;
    msg += `   📈 ${t.trades} trades • Vol: ${fmt(t.volume)}\n`;
    if (t.holding > 0 && t.holdingUsd > 1) {
      msg += `   💎 Holding: ${fmt(t.holdingUsd)}\n`;
    }
    msg += `\n`;
  });
  
  msg += `_Updated ${fmtTime()} UTC_`;
  
  return msg;
}

// ═══════════════════════════════════════════════════════════════════════════════
// OHLCV CHART GENERATION
// ═══════════════════════════════════════════════════════════════════════════════

// Fetch OHLCV candle data
async function fetchOHLCVData(poolId, timeframe = '1h', limit = 48) {
  if (!poolId) return [];
  
  try {
    // Try Orbit API first
    const res = await fetchWithRetry(ORBIT.candles(poolId, timeframe, limit));
    const data = await res.json();
    
    if (Array.isArray(data) && data.length > 0) {
      return data.map(c => ({
        time: c.time || c.timestamp || c.t,
        open: parseFloat(c.open || c.o) || 0,
        high: parseFloat(c.high || c.h) || 0,
        low: parseFloat(c.low || c.l) || 0,
        close: parseFloat(c.close || c.c) || 0,
        volume: parseFloat(c.volume || c.v) || 0,
      })).sort((a, b) => a.time - b.time);
    }
    
    return [];
  } catch (e) {
    log.debug('OHLCV fetch error:', e.message);
    return [];
  }
}

// Generate price chart image
async function generatePriceChart(candles, symbol, timeframe = '1h') {
  if (!candles || candles.length < 2) return null;
  
  try {
    const renderer = getChartRenderer();
    // Prepare data
    const labels = candles.map(c => {
      const d = dayjs(c.time * 1000);
      return timeframe.includes('d') ? d.format('MMM D') : d.format('HH:mm');
    });
    
    const prices = candles.map(c => c.close);
    const volumes = candles.map(c => c.volume);
    
    // Determine if price went up or down
    const startPrice = prices[0];
    const endPrice = prices[prices.length - 1];
    const priceUp = endPrice >= startPrice;
    const lineColor = priceUp ? '#00ff88' : '#ff4444';
    const fillColor = priceUp ? 'rgba(0, 255, 136, 0.1)' : 'rgba(255, 68, 68, 0.1)';
    
    const config = {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: `${symbol} Price`,
          data: prices,
          borderColor: lineColor,
          backgroundColor: fillColor,
          fill: true,
          tension: 0.4,
          pointRadius: 0,
          borderWidth: 2,
        }]
      },
      options: {
        responsive: false,
        plugins: {
          legend: { display: false },
          title: {
            display: true,
            text: `${symbol} • ${timeframe.toUpperCase()}`,
            color: '#ffffff',
            font: { size: 16, weight: 'bold' }
          }
        },
        scales: {
          x: {
            grid: { color: 'rgba(255,255,255,0.1)' },
            ticks: { color: '#888', maxTicksLimit: 8 }
          },
          y: {
            grid: { color: 'rgba(255,255,255,0.1)' },
            ticks: { 
              color: '#888',
              callback: (v) => '$' + formatNumber(v)
            }
          }
        }
      }
    };
    
    const buffer = await renderer.renderToBuffer(config);
    return buffer;
  } catch (e) {
    log.error('Chart generation error:', e.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENHANCED LIQUIDITY TRACKING
// ═══════════════════════════════════════════════════════════════════════════════

// Track significant liquidity changes
const recentLiquidityEvents = new BoundedCache(100, 3600000); // 1 hour TTL

function recordLiquidityEvent(event) {
  const key = `${event.poolId}_${event.timestamp}`;
  recentLiquidityEvents.set(key, event);
}

// Get liquidity history for a pool
function getLiquidityHistory(poolId, limit = 20) {
  const events = [];
  for (const [key, event] of recentLiquidityEvents.cache.entries()) {
    if (event.value.poolId === poolId) {
      events.push(event.value);
    }
  }
  return events
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit);
}

// Format liquidity history message
function formatLiquidityHistory(poolId) {
  const pool = poolMap.get(poolId);
  if (!pool) return '❌ Pool not found';
  
  const events = getLiquidityHistory(poolId);
  
  if (events.length === 0) {
    return `💧 *Liquidity History*\n\n*${escMd(pool.pairName)}*\n\n_No recent liquidity events_`;
  }
  
  let msg = `💧 *Liquidity History*\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `*${escMd(pool.pairName)}*\n\n`;
  
  events.forEach(e => {
    const icon = e.isAdd ? '🟢 ADD' : '🔴 REMOVE';
    const time = timeAgo(e.timestamp);
    msg += `${icon} • ${fmt(e.usd)} • ${time}\n`;
  });
  
  return msg;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ORBIT WEBSOCKET
// ═══════════════════════════════════════════════════════════════════════════════
let orbitWs = null;
let orbitWsRunning = false;
const activeIntervals = [];
const activeCronJobs = [];
let healthServer = null;
const seenTxs = new Set();
let orbitWsReconnectAttempts = 0;
let orbitWsPingInterval = null;
let heliusWsReconnectAttempts = 0;
let heliusWsPingInterval = null;

function getReconnectDelay(attempts) {
  // Exponential backoff: 15s, 30s, 60s, 120s, max 5 minutes
  const delay = CONFIG.wsReconnectDelay * Math.pow(2, Math.min(attempts, 5));
  return Math.min(delay, 5 * 60 * 1000);
}

async function connectOrbitWs() {
  if (!orbitWsRunning || pools.length === 0) return;
  
  try {
    // Clean up existing connection before creating new one
    if (orbitWs) {
      try {
        orbitWs.removeAllListeners();
        if (orbitWs.readyState === WebSocket.OPEN) {
          orbitWs.close();
        }
      } catch (e) {}
      orbitWs = null;
    }
    if (orbitWsPingInterval) { clearInterval(orbitWsPingInterval); orbitWsPingInterval = null; }

    const ticketRes = await fetchWithRetry(ORBIT.wsTicket(), {}, 2);
    const ticketData = await ticketRes.json();
    const ticket = ticketData?.ticket;
    if (!ticket) {
      log.warn('⚠️ No WS ticket, will retry...');
      setTimeout(connectOrbitWs, getReconnectDelay(orbitWsReconnectAttempts++));
      return;
    }

    const url = CONFIG.orbitApi.replace('https://', 'wss://') + `/ws?ticket=${ticket}`;
    orbitWs = new WebSocket(url);

    orbitWs.on('open', () => {
      log.info('✅ Orbit WS connected');
      orbitWsReconnectAttempts = 0; // Reset backoff on successful connect
      pools.forEach(p => {
        try {
          orbitWs.send(JSON.stringify({ type: 'subscribe', pool: p.id, limit: 10 }));
        } catch (e) {
          log.debug('Orbit WS subscribe error:', e.message);
        }
      });
      // Keepalive ping every 30 seconds to detect zombie connections
      orbitWsPingInterval = setInterval(() => {
        if (orbitWs?.readyState === WebSocket.OPEN) {
          try { orbitWs.ping(); } catch (e) { /* will trigger close */ }
        }
      }, 30000);
    });

    orbitWs.on('message', (data) => {
      try {
        handleOrbitMessage(JSON.parse(data.toString()));
      } catch (e) {
        log.debug('Orbit WS message parse error:', e.message);
      }
    });

    orbitWs.on('pong', () => { /* Connection is alive */ });

    orbitWs.on('close', () => {
      log.warn('❌ Orbit WS closed');
      if (orbitWsPingInterval) { clearInterval(orbitWsPingInterval); orbitWsPingInterval = null; }
      if (orbitWsRunning) setTimeout(connectOrbitWs, getReconnectDelay(orbitWsReconnectAttempts++));
    });

    orbitWs.on('error', (e) => {
      log.error('⚠️ Orbit WS error:', e.message);
    });
  } catch (e) {
    log.error('⚠️ Orbit WS connect failed:', e.message);
    setTimeout(connectOrbitWs, getReconnectDelay(orbitWsReconnectAttempts++));
  }
}

function handleOrbitMessage(msg) {
  // Skip heartbeat/ping messages
  if (msg.type === 'ping' || msg.type === 'pong' || msg.type === 'heartbeat') {
    return;
  }
  
  // Extract signature early for deduplication
  const sig = msg.signature || msg.trade?.signature || msg.tx || msg.txId;
  
  // Skip if we've already processed this transaction
  if (sig && seenTxs.has(sig)) {
    return;
  }
  
  // Use the improved discriminator-based detection
  const detection = detectTransactionType(msg);
  
  log.debug(`📨 WS: Detected ${detection.type} | Direction: ${detection.direction} | Confidence: ${detection.confidence}`);
  
  // Skip unknown messages
  if (detection.type === TX_TYPE.UNKNOWN) {
    log.debug(`❓ Unknown msg, keys: ${Object.keys(msg).slice(0,8).join(',')}`);
    return;
  }
  
  // Extract common fields
  const poolId = msg.pool || msg.poolId || msg.poolAddress || msg.pair;
  const user = msg.user || msg.wallet || msg.owner || msg.trader || msg.maker;
  const timestamp = msg.timestamp || msg.ts || msg.time || Date.now();
  
  // Route to appropriate handler
  switch (detection.type) {
    case TX_TYPE.SWAP:
      log.info(`📊 Trade: ${detection.direction || 'unknown'} [${sig?.slice(0,8) || 'no-sig'}...] conf:${detection.confidence}`);
      processTrade({ ...msg, _detectedDirection: detection.direction });
      break;

    case TX_TYPE.LP_ADD:
      log.info(`💧 LP Add [${sig?.slice(0,8) || 'no-sig'}...] conf:${detection.confidence}`);
      processLpEvent({ ...msg, _isAdd: true });
      break;

    case TX_TYPE.LP_REMOVE:
      log.info(`🔥 LP Remove [${sig?.slice(0,8) || 'no-sig'}...] conf:${detection.confidence}`);
      processLpEvent({ ...msg, _isAdd: false });
      break;

    case TX_TYPE.CLOSE_POSITION:
      log.info(`🗑️ Close Position [${sig?.slice(0,8) || 'no-sig'}...] conf:${detection.confidence}`);
      processLpEvent({ ...msg, _isAdd: false });
      break;

    case TX_TYPE.POOL_INIT:
      log.info(`🆕 Pool Initialized [${sig?.slice(0,8) || 'no-sig'}...] conf:${detection.confidence}`);
      if (sig) { seenTxs.add(sig); persistSeenTx(sig); }
      // Trigger pool list refresh so new pools appear immediately
      fetchPools().then(() => {
        broadcastNewPoolAlert({ poolId, user, sig, timestamp }).catch(e => log.debug('New pool alert failed:', e.message));
      }).catch(e => log.debug('Pool refresh after init failed:', e.message));
      break;

    case TX_TYPE.FEES_DISTRIBUTED:
      log.info(`💸 Fees Distributed [${sig?.slice(0,8) || 'no-sig'}...] conf:${detection.confidence}`);
      if (sig) { seenTxs.add(sig); persistSeenTx(sig); }
      break;

    case TX_TYPE.CLAIM_REWARDS:
      log.info(`🎁 Reward Claim [${sig?.slice(0,8) || 'no-sig'}...] conf:${detection.confidence}`);
      if (sig) { seenTxs.add(sig); persistSeenTx(sig); }
      broadcastRewardClaimAlert({ user, sig, poolId, timestamp }).catch(e => log.debug('Reward alert failed:', e.message));
      break;

    case TX_TYPE.LOCK_LIQUIDITY:
      log.info(`🔒 Liquidity Locked [${sig?.slice(0,8) || 'no-sig'}...] conf:${detection.confidence}`);
      if (sig) { seenTxs.add(sig); persistSeenTx(sig); }
      broadcastLockAlert({ poolId, isLock: true, user, sig, timestamp }).catch(e => log.debug('Lock alert failed:', e.message));
      break;

    case TX_TYPE.UNLOCK_LIQUIDITY:
      log.info(`🔓 Liquidity Unlocked [${sig?.slice(0,8) || 'no-sig'}...] conf:${detection.confidence}`);
      if (sig) { seenTxs.add(sig); persistSeenTx(sig); }
      broadcastLockAlert({ poolId, isLock: false, user, sig, timestamp }).catch(e => log.debug('Unlock alert failed:', e.message));
      break;

    case TX_TYPE.SYNC_STAKE:
      log.info(`🔄 Stake Sync [${sig?.slice(0,8) || 'no-sig'}...] conf:${detection.confidence}`);
      if (sig) { seenTxs.add(sig); persistSeenTx(sig); }
      break;

    case TX_TYPE.CLOSE_POOL:
      log.info(`🚫 Pool Closed [${sig?.slice(0,8) || 'no-sig'}...] conf:${detection.confidence}`);
      if (sig) { seenTxs.add(sig); persistSeenTx(sig); }
      broadcastClosePoolAlert({ poolId, user, sig, timestamp }).catch(e => log.debug('Close pool alert failed:', e.message));
      break;

    case TX_TYPE.PROTOCOL_FEES:
      log.info(`💰 Protocol Fees [${sig?.slice(0,8) || 'no-sig'}...] conf:${detection.confidence}`);
      if (sig) { seenTxs.add(sig); persistSeenTx(sig); }
      broadcastProtocolFeeAlert({ poolId, user, sig, timestamp }).catch(e => log.debug('Protocol fee alert failed:', e.message));
      break;

    case TX_TYPE.ADMIN:
      log.info(`⚠️ Admin Action [${sig?.slice(0,8) || 'no-sig'}...] conf:${detection.confidence}`);
      if (sig) { seenTxs.add(sig); persistSeenTx(sig); }
      broadcastAdminAlert({ poolId, user, sig, timestamp, eventName: detection.eventName }).catch(e => log.debug('Admin alert failed:', e.message));
      break;

    case TX_TYPE.SETUP:
      log.info(`🔧 Setup [${sig?.slice(0,8) || 'no-sig'}...] conf:${detection.confidence}`);
      if (sig) { seenTxs.add(sig); persistSeenTx(sig); }
      break; // dedup only, no user alert
  }
}

function processTrade(msg) {
  const trade = msg.trade || msg;
  const poolId = msg.pool || trade.pool || msg.poolId;
  const sig = trade.signature || msg.signature || msg.tx || msg.txId;
  
  // Double-check deduplication (in case called directly)
  if (!sig) {
    log.warn('⚠️ Trade without signature, skipping');
    return;
  }
  
  if (seenTxs.has(sig)) {
    return; // Already processed
  }
  
  // Mark as seen IMMEDIATELY before any async operations
  seenTxs.add(sig);
  persistSeenTx(sig);

  if (!poolId) {
    log.warn('⚠️ Trade without poolId, skipping');
    return;
  }
  
  const pool = poolMap.get(poolId);
  if (!pool) {
    // Try to find pool by checking all pools (might be different ID format)
    return;
  }
  
  const usd = estimateTradeUsd(trade, pool);
  
  // Use pre-detected direction if available (from discriminator-based detection)
  // Otherwise fall back to the trade.side field
  let isBuy;
  if (msg._detectedDirection) {
    isBuy = msg._detectedDirection === 'buy';
  } else {
    isBuy = trade.side === 'buy';
  }
  
  // Log for debugging
  log.info(`📊 Trade: ${pool.pairName} ${isBuy ? 'BUY' : 'SELL'} $${usd.toFixed(0)} [${sig.slice(0,8)}...]`);
  
  broadcastTradeAlert({ pool, trade, usd, isBuy, sig });
  cleanSeenTxs();
}

function processLpEvent(msg) {
  const poolId = msg.pool || msg.poolId;
  const sig = msg.signature || msg.tx || msg.txId;
  
  // Double-check deduplication
  if (!sig) {
    log.warn('⚠️ LP event without signature, skipping');
    return;
  }
  
  if (seenTxs.has(sig)) {
    return; // Already processed
  }
  
  // Mark as seen IMMEDIATELY
  seenTxs.add(sig);
  persistSeenTx(sig);

  if (!poolId) return;
  
  const pool = poolMap.get(poolId);
  if (!pool) return;
  
  // Use the pre-detected direction if available (from discriminator-based detection)
  // Otherwise fall back to heuristic detection
  let isAdd = msg._isAdd;
  
  if (isAdd === undefined) {
    // Fallback heuristic detection
    isAdd = 
      msg.type === 'lp_add' || 
      msg.type === 'addLiquidity' ||
      msg.type === 'add_liquidity' ||
      msg.type === 'deposit' ||
      msg.action === 'add' ||
      msg.action === 'addLiquidity' ||
      msg.action === 'deposit' ||
      (msg.name && msg.name.toLowerCase().includes('add')) ||
      (msg.instruction && msg.instruction.toLowerCase().includes('add')) ||
      (msg.liquidityDelta && parseFloat(msg.liquidityDelta) > 0);
  }
  
  const usd = estimateLpUsd(msg, pool);
  
  // Log for debugging
  log.info(`💧 LP: ${pool.pairName} ${isAdd ? 'ADD' : 'REMOVE'} $${usd.toFixed(0)} [${sig.slice(0,8)}...]`);
  
  // Record for liquidity history
  recordLiquidityEvent({
    poolId,
    pairName: pool.pairName,
    isAdd,
    usd,
    sig,
    timestamp: Date.now(),
    wallet: msg.wallet || msg.user || msg.owner,
  });
  
  broadcastLpAlert({ pool, isAdd, usd, sig, msg });
  cleanSeenTxs();
}

function cleanSeenTxs() {
  if (seenTxs.size > 5000) {
    const arr = [...seenTxs];
    seenTxs.clear();
    arr.slice(-2500).forEach(s => seenTxs.add(s));
  }
  // Persist to DB and clean old entries (keep last 24h)
  if (db) {
    try {
      db.prepare('DELETE FROM seen_txs WHERE added_at < ?').run(Date.now() - 24 * 60 * 60 * 1000);
    } catch (e) {}
  }
}

// Load seenTxs from DB on startup to prevent post-restart duplicates
function loadSeenTxs() {
  if (!db) return;
  try {
    const rows = db.prepare('SELECT sig FROM seen_txs WHERE added_at > ? ORDER BY added_at DESC LIMIT 2500')
      .all(Date.now() - 24 * 60 * 60 * 1000);
    rows.forEach(r => seenTxs.add(r.sig));
    log.info(`✅ Loaded ${rows.length} recent tx signatures from DB`);
  } catch (e) {
    log.debug('Failed to load seenTxs:', e.message);
  }
}

// Persist a signature to DB
function persistSeenTx(sig) {
  if (!db || !sig) return;
  try {
    db.prepare('INSERT OR IGNORE INTO seen_txs (sig, added_at) VALUES (?, ?)').run(sig, Date.now());
  } catch (e) {}
}

// Clean up stale price cache entries (older than 30 minutes)
function cleanPriceCache() {
  const maxAge = 30 * 60 * 1000; // 30 minutes
  const now = Date.now();
  for (const [mint, data] of priceCache.entries()) {
    if (now - data.updatedAt > maxAge) {
      priceCache.delete(mint);
    }
  }
}

// Clean up stale token overview cache
function cleanTokenOverviewCache() {
  const maxAge = 60 * 60 * 1000; // 1 hour
  const now = Date.now();
  for (const [mint, data] of tokenOverviewCache.entries()) {
    if (now - (data.fetchedAt || data.timestamp || 0) > maxAge) {
      tokenOverviewCache.delete(mint);
    }
  }
}

// Clean up user stake cache
function cleanUserStakeCache() {
  const maxAge = 30 * 60 * 1000; // 30 minutes
  const now = Date.now();
  for (const [wallet, data] of userStakeCache.entries()) {
    if (now - data.timestamp > maxAge) {
      userStakeCache.delete(wallet);
    }
  }
}

// Clean up balance cache
function cleanBalanceCache() {
  const now = Date.now();
  for (const [wallet, data] of balanceCache.entries()) {
    if (now - data.timestamp > BALANCE_CACHE_TTL * 2) {
      balanceCache.delete(wallet);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELIUS WEBSOCKET
// ═══════════════════════════════════════════════════════════════════════════════
let heliusWs = null;
let heliusWsRunning = false;
let currentSubscriptions = new Set();

async function connectHeliusWs() {
  if (!heliusWsRunning) return;

  // Clear keepalive from previous connection
  if (heliusWsPingInterval) { clearInterval(heliusWsPingInterval); heliusWsPingInterval = null; }

  const wallets = getAllTrackedWallets();
  if (wallets.length === 0) {
    setTimeout(connectHeliusWs, 30000);
    return;
  }

  try {
    // Clean up existing connection before creating new one
    if (heliusWs) {
      try {
        heliusWs.removeAllListeners();
        if (heliusWs.readyState === WebSocket.OPEN) {
          heliusWs.close();
        }
      } catch (e) {}
      heliusWs = null;
    }
    currentSubscriptions.clear();

    heliusWs = new WebSocket(HELIUS.wss);

    heliusWs.on('open', () => {
      log.info(`✅ Helius WS connected (${wallets.length} wallets)`);
      heliusWsReconnectAttempts = 0;

      // Keepalive ping every 30s to detect zombie connections
      heliusWsPingInterval = setInterval(() => {
        if (heliusWs?.readyState === WebSocket.OPEN) {
          try { heliusWs.ping(); } catch (e) { /* will trigger close */ }
        }
      }, 30000);

      wallets.forEach(wallet => {
        if (!currentSubscriptions.has(wallet)) {
          try {
            heliusWs.send(JSON.stringify({
              jsonrpc: '2.0',
              id: `sub_${wallet}`,
              method: 'logsSubscribe',
              params: [{ mentions: [wallet] }, { commitment: 'confirmed' }]
            }));
            currentSubscriptions.add(wallet);
          } catch (e) {
            log.debug('Helius subscription error:', e.message);
          }
        }
      });
    });

    heliusWs.on('message', (data) => {
      try {
        handleHeliusMessage(JSON.parse(data.toString()));
      } catch (e) {
        log.debug('Helius WS message parse error:', e.message);
      }
    });

    heliusWs.on('close', () => {
      log.warn('❌ Helius WS closed');
      if (heliusWsPingInterval) { clearInterval(heliusWsPingInterval); heliusWsPingInterval = null; }
      currentSubscriptions.clear();
      if (heliusWsRunning) setTimeout(connectHeliusWs, getReconnectDelay(heliusWsReconnectAttempts++));
    });

    heliusWs.on('error', (e) => {
      log.error('⚠️ Helius WS error:', e.message);
    });
  } catch (e) {
    log.error('⚠️ Helius WS connect failed:', e.message);
    setTimeout(connectHeliusWs, getReconnectDelay(heliusWsReconnectAttempts++));
  }
}

function refreshWalletSubscriptions() {
  if (!heliusWs || heliusWs.readyState !== WebSocket.OPEN) {
    // Connection not open — reconnect will pick up the new wallet list
    if (heliusWsRunning) connectHeliusWs();
    return;
  }

  const wallets = new Set(getAllTrackedWallets());

  // Subscribe to new wallets not yet tracked
  for (const wallet of wallets) {
    if (!currentSubscriptions.has(wallet)) {
      try {
        heliusWs.send(JSON.stringify({
          jsonrpc: '2.0',
          id: `sub_${wallet}`,
          method: 'logsSubscribe',
          params: [{ mentions: [wallet] }, { commitment: 'confirmed' }]
        }));
        currentSubscriptions.add(wallet);
        log.debug(`Helius WS: subscribed to ${wallet}`);
      } catch (e) {
        log.debug('Helius incremental subscribe error:', e.message);
      }
    }
  }

  // Unsubscribe wallets that were removed
  for (const wallet of currentSubscriptions) {
    if (!wallets.has(wallet)) {
      // Note: Solana logsSubscribe doesn't have a clean per-mention unsubscribe,
      // but removing from tracking set means we'll ignore future messages for it.
      currentSubscriptions.delete(wallet);
      log.debug(`Helius WS: untracked ${wallet}`);
    }
  }
}

// Separate dedup set for wallet alerts — prevents cross-source suppression
// (a tx seen via Orbit WS for trade alerts should still trigger wallet alerts)
const seenWalletTxs = new Set();

async function handleHeliusMessage(msg) {
  if (msg.result !== undefined) return;
  if (msg.method === 'logsNotification' && msg.params?.result?.value) {
    const { signature } = msg.params.result.value;
    if (!signature || seenWalletTxs.has(signature)) return;
    seenWalletTxs.add(signature);
    // Also add to main seenTxs so backup polling doesn't re-process
    seenTxs.add(signature);
    persistSeenTx(signature);
    await processWalletTransaction(signature);
    // Clean wallet dedup set periodically
    if (seenWalletTxs.size > 5000) {
      const arr = [...seenWalletTxs];
      seenWalletTxs.clear();
      arr.slice(-2500).forEach(s => seenWalletTxs.add(s));
    }
  }
}

async function processWalletTransaction(signature) {
  let tx = null;
  
  // Primary: Helius Enhanced Transactions API
  try {
    const res = await fetchWithRetry(`${HELIUS.api}/transactions/?api-key=${CONFIG.heliusKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactions: [signature] })
    });
    
    const txs = await res.json();
    if (txs?.[0]) {
      tx = txs[0];
      updateApiHealth('helius', true);
    }
  } catch (e) {
    log.warn('⚠️ Helius tx API failed:', e.message);
    updateApiHealth('helius', false);
  }
  
  // Backup: Raw RPC (basic parsing)
  if (!tx) {
    try {
      const rpcRes = await fetchWithRetry(BACKUP_APIS.ankrRpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getTransaction',
          params: [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]
        })
      });
      
      const rpcData = await rpcRes.json();
      if (rpcData?.result) {
        // Convert RPC format to simplified format
        const rawTx = rpcData.result;
        tx = {
          feePayer: rawTx.transaction?.message?.accountKeys?.[0]?.pubkey,
          tokenTransfers: [],
          nativeTransfers: [],
          accountData: rawTx.transaction?.message?.accountKeys?.map(k => ({ account: k.pubkey || k })) || [],
        };
        
        // Parse token transfers from instructions
        const instructions = rawTx.transaction?.message?.instructions || [];
        for (const ix of instructions) {
          if (ix.parsed?.type === 'transfer' && ix.program === 'spl-token') {
            tx.tokenTransfers.push({
              mint: ix.parsed.info?.mint,
              tokenAmount: parseFloat(ix.parsed.info?.amount || 0),
            });
          }
        }
        
        // Parse SOL transfers
        const preBalances = rawTx.meta?.preBalances || [];
        const postBalances = rawTx.meta?.postBalances || [];
        if (preBalances[0] !== undefined && postBalances[0] !== undefined) {
          const diff = postBalances[0] - preBalances[0];
          if (Math.abs(diff) > 0) {
            tx.nativeTransfers.push({ amount: Math.abs(diff) });
          }
        }
      }
    } catch (e) {
      log.warn('⚠️ Backup RPC also failed:', e.message);
    }
  }
  
  // Backup 2: Solscan API
  if (!tx) {
    try {
      const solscanRes = await fetchWithRetry(SOLSCAN.tx(signature));
      const solscanData = await solscanRes.json();
      if (solscanData?.status === 'Success' || solscanData?.txHash) {
        tx = {
          feePayer: solscanData.signer?.[0] || solscanData.fee_payer,
          tokenTransfers: [],
          nativeTransfers: [],
          accountData: (solscanData.inputAccount || []).map(a => ({ account: a })),
        };
        
        // Parse token transfers from Solscan format
        if (solscanData.tokenTransfers || solscanData.token_transfer) {
          const transfers = solscanData.tokenTransfers || solscanData.token_transfer || [];
          for (const t of transfers) {
            tx.tokenTransfers.push({
              mint: t.token_address || t.mint,
              tokenAmount: parseFloat(t.amount || t.token_amount || 0),
            });
          }
        }
        
        // SOL amount
        if (solscanData.sol_transfer || solscanData.lamport) {
          const solAmount = solscanData.sol_transfer?.[0]?.amount || solscanData.lamport || 0;
          if (solAmount > 0) {
            tx.nativeTransfers.push({ amount: solAmount });
          }
        }
        
        updateApiHealth('solscan', true);
        log.debug('📡 Using Solscan backup for tx parsing');
      }
    } catch (e) {
      log.warn('⚠️ Solscan API also failed:', e.message);
      updateApiHealth('solscan', false);
    }
  }
  
  if (!tx) return;
  
  try {
    const accounts = tx.accountData?.map(a => a.account) || [];
    if (!isOrbitTransaction(accounts)) return;
    
    const walletAddr = tx.feePayer;
    let tokenSymbol = '';
    let isBuy = false;

    if (tx.events?.swap) {
      // Helius Enhanced API path — most reliable
      const swap = tx.events.swap;
      tokenSymbol = getSymbol(swap.tokenOutputs?.[0]?.mint || swap.tokenInputs?.[0]?.mint);
      isBuy = swap.tokenOutputs?.some(t => t.mint === CONFIG.cipherMint);
    } else if (tx.tokenTransfers?.length > 0) {
      // Backup RPC / Solscan path — infer direction from token transfers
      const transfers = tx.tokenTransfers;
      tokenSymbol = getSymbol(transfers[0].mint);
      // Check if wallet received a known token (buy) or sent it (sell)
      const received = transfers.find(t => t.toUserAccount === walletAddr || t.destination === walletAddr);
      const sent = transfers.find(t => t.fromUserAccount === walletAddr || t.source === walletAddr);
      if (received && received.mint) {
        tokenSymbol = getSymbol(received.mint);
        isBuy = true;
      } else if (sent && sent.mint) {
        tokenSymbol = getSymbol(sent.mint);
        isBuy = false;
      }
    }
    
    const usdValue = estimateWalletTxUsd(tx) / 2; // Divide by 2: estimateWalletTxUsd sums both sides of a swap

    broadcastWalletAlert({ wallet: walletAddr, signature, tokenSymbol, isBuy, usdValue });
  } catch (e) {
    log.error('⚠️ Wallet tx parse failed:', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// BOT SETUP
// ═══════════════════════════════════════════════════════════════════════════════
const bot = new Telegraf(CONFIG.botToken);

// User-friendly error messages
const ERROR_MESSAGES = {
  network: '⚠️ Network issue. Please try again.',
  timeout: '⚠️ Request timed out. Please try again.',
  rateLimit: '⚠️ Too many requests. Please wait a moment.',
  notFound: '⚠️ Not found. Please check and try again.',
  unknown: '⚠️ Something went wrong. Please try again.',
};

function getUserFriendlyError(error) {
  const msg = error?.message?.toLowerCase() || '';
  const desc = error?.description?.toLowerCase() || '';
  
  if (msg.includes('timeout') || msg.includes('timed out')) return ERROR_MESSAGES.timeout;
  if (msg.includes('network') || msg.includes('econnrefused')) return ERROR_MESSAGES.network;
  if (msg.includes('429') || desc.includes('too many')) return ERROR_MESSAGES.rateLimit;
  if (msg.includes('404') || msg.includes('not found')) return ERROR_MESSAGES.notFound;
  return ERROR_MESSAGES.unknown;
}

// Safe messaging utilities - handle Telegram API errors gracefully
const safeAnswer = async (ctx, text) => {
  try { await ctx.answerCbQuery(text); } catch (e) { log.debug('Answer failed:', e.message); }
};

const safeEdit = async (ctx, text, extra) => {
  try { 
    await ctx.editMessageText(text, extra); 
    return true;
  } catch (e) {
    // If edit fails (message not modified or deleted), try sending new message
    if (e.description?.includes('message is not modified') || 
        e.description?.includes('message to edit not found')) {
      log.debug('Edit skipped - message not modified');
      return false;
    }
    log.debug('Edit failed:', e.message);
    return false;
  }
};

const safeReply = async (ctx, text, extra = {}) => {
  try { 
    return await ctx.reply(text, extra); 
  } catch (e) {
    log.error('Reply failed:', e.message);
    return null;
  }
};

const safeSend = async (chatId, text, extra = {}) => {
  try { 
    return await bot.telegram.sendMessage(chatId, text, extra); 
  } catch (e) {
    // Handle common Telegram errors
    if (e.description?.includes('bot was blocked') || 
        e.description?.includes('chat not found') ||
        e.description?.includes('user is deactivated')) {
      // User blocked bot or deleted account - mark as inactive
      const user = users.get(chatId);
      if (user) {
        user.enabled = false;
        user.blocked = true;
      }
    }
    return null;
  }
};

// Middleware to track user activity (for auto-sync feature)
bot.use((ctx, next) => {
  if (ctx.chat?.id) {
    const user = users.get(ctx.chat.id);
    if (user) {
      user.lastActive = Date.now();
    }
  }
  return next();
});

// Bot-level error handler middleware
bot.catch((err, ctx) => {
  log.error(`Bot error for ${ctx.updateType}:`, err.message);
  // Don't crash on individual request errors
});

// ═══════════════════════════════════════════════════════════════════════════════
// MENUS
// ═══════════════════════════════════════════════════════════════════════════════
const menu = {
  welcome: () => Markup.inlineKeyboard([
    [Markup.button.callback('🚀 Get Started', 'setup:start')],
    [Markup.button.callback('ℹ️ How It Works', 'info:about')],
    [Markup.button.url('🌐 Orbit Markets', 'https://markets.cipherlabsx.com')],
  ]),
  
  setup: () => Markup.inlineKeyboard([
    [Markup.button.callback('🔷 CIPHER Alerts', 'preset:cipher')],
    [Markup.button.callback('💧 LP Tracking', 'preset:lp')],
    [Markup.button.callback('📊 Everything', 'preset:all')],
    [Markup.button.callback('« Back', 'nav:welcome')],
  ]),
  
  main: (u) => {
    const snoozed = isUserSnoozed(u);
    const quietActive = isQuietHoursActive(u);
    const btns = [
      [Markup.button.callback('🔷 CIPHER', 'nav:cipher'), Markup.button.callback('👛 Wallets', 'nav:wallets')],
    ];
    
    // Pool Explorer & Watchlist
    btns.push([
      Markup.button.callback('🌐 Pools', 'nav:pools'),
      Markup.button.callback('⭐ Watchlist', 'nav:watchlist'),
    ]);
    
    // LP & Portfolio
    btns.push([
      Markup.button.callback('💧 LP Alerts', 'nav:lp'),
      Markup.button.callback('📈 Portfolio', 'nav:portfolio'),
    ]);
    
    const otherLabel = u?.trackOtherPools !== false ? '🟢 Pool Alerts' : '⚫ Pool Alerts';
    let alertLabel = '🔔 Alert Controls';
    if (!u?.enabled) alertLabel = '⏸️ Alerts Paused';
    else if (snoozed) alertLabel = quietActive ? '🌙 Quiet Hours' : '🔕 Snoozed';

    btns.push([
      Markup.button.callback(otherLabel, 'nav:othersettings'),
      Markup.button.callback(alertLabel, 'nav:snooze'),
    ]);
    btns.push([
      Markup.button.callback('📜 Alert History', 'nav:history'),
      Markup.button.callback('⚙️ Settings', 'nav:settings'),
    ]);
    
    return Markup.inlineKeyboard(btns);
  },
  
  cipher: (u) => Markup.inlineKeyboard([
    [Markup.button.callback(`${u?.cipherBuys ? '✅' : '⬜'} Buy Alerts`, 'tog:cipherBuys'),
     Markup.button.callback(`${u?.cipherSells ? '✅' : '⬜'} Sell Alerts`, 'tog:cipherSells')],
    [Markup.button.callback(`${u?.cipherLpAdd ? '✅' : '⬜'} LP Add`, 'tog:cipherLpAdd'),
     Markup.button.callback(`${u?.cipherLpRemove ? '✅' : '⬜'} LP Remove`, 'tog:cipherLpRemove')],
    [Markup.button.callback(`💰 Minimum: ${fmt(u?.cipherThreshold || 100)}`, 'thresh:cipher')],
    [Markup.button.callback('🏠 Menu', 'nav:main')],
  ]),
  
  lp: (u) => Markup.inlineKeyboard([
    [Markup.button.callback(`${u?.otherLpAdd ? '✅' : '⬜'} LP Add Alerts`, 'tog:otherLpAdd'),
     Markup.button.callback(`${u?.otherLpRemove ? '✅' : '⬜'} LP Remove`, 'tog:otherLpRemove')],
    [Markup.button.callback(`💰 Minimum: ${fmt(u?.otherLpThreshold || 500)}`, 'thresh:lp')],
    [Markup.button.callback('🏠 Menu', 'nav:main')],
  ]),
  
  // Pool Explorer menu
  pools: (u, page = 0, sortBy = 'volume') => {
    const perPage = 5;
    const sortedPools = getSortedPools(sortBy);
    const start = page * perPage;
    const slice = sortedPools.slice(start, start + perPage);
    const totalPages = Math.ceil(sortedPools.length / perPage) || 1;
    
    const btns = [];
    
    // Sort buttons
    btns.push([
      Markup.button.callback(sortBy === 'volume' ? '📊 Volume ✓' : '📊 Volume', 'pools:sort:volume'),
      Markup.button.callback(sortBy === 'tvl' ? '💰 TVL ✓' : '💰 TVL', 'pools:sort:tvl'),
      Markup.button.callback(sortBy === 'trades' ? '🔄 Trades ✓' : '🔄 Trades', 'pools:sort:trades'),
    ]);
    
    // Pool buttons
    slice.forEach(p => {
      const pairName = p.pairName || formatPair(p.baseMint || p.base, p.quoteMint || p.quote);
      const vol = orbitVolumes.pools?.[p.id]?.volume24h || 0;
      const volStr = vol > 0 ? ` • ${fmtCompact(vol)}` : '';
      const icon = p.isCipher ? '🔷' : '🌐';
      btns.push([Markup.button.callback(`${icon} ${pairName}${volStr}`, `pool:view:${p.id}`)]);
    });
    
    // Pagination
    const navBtns = [];
    if (page > 0) navBtns.push(Markup.button.callback('◀️ Prev', `pools:page:${page - 1}:${sortBy}`));
    navBtns.push(Markup.button.callback(`${page + 1}/${totalPages}`, 'noop'));
    if (start + perPage < sortedPools.length) navBtns.push(Markup.button.callback('Next ▶️', `pools:page:${page + 1}:${sortBy}`));
    btns.push(navBtns);
    
    // Action buttons
    btns.push([
      Markup.button.callback('🔥 Trending', 'nav:trending'),
      Markup.button.callback('🆕 New', 'nav:newpools'),
    ]);
    btns.push([
      Markup.button.callback('🔍 Search', 'pools:search'),
      Markup.button.callback('⚙️ Alerts', 'nav:othersettings'),
    ]);
    btns.push([Markup.button.callback('🏠 Menu', 'nav:main')]);
    
    return Markup.inlineKeyboard(btns);
  },
  
  // Trending pools menu
  trending: () => {
    const topPools = getTopPoolsByVolume(10);
    const btns = [];

    if (topPools.length === 0) {
      btns.push([Markup.button.callback('📋 All Pools', 'nav:pools')]);
      btns.push([Markup.button.callback('🏠 Menu', 'nav:main')]);
      return Markup.inlineKeyboard(btns);
    }

    topPools.forEach((p, i) => {
      const pairName = p.pairName || formatPair(p.baseMint || p.base, p.quoteMint || p.quote);
      const vol = orbitVolumes.pools?.[p.id]?.volume24h || 0;
      const icon = p.isCipher ? '🔷' : '🌐';
      const rank = ['🥇', '🥈', '🥉'][i] || `${i + 1}.`;
      btns.push([Markup.button.callback(`${rank} ${icon} ${pairName} • ${fmtCompact(vol)}`, `pool:view:${p.id}`)]);
    });

    btns.push([
      Markup.button.callback('🆕 New Pools', 'nav:newpools'),
      Markup.button.callback('📋 All Pools', 'nav:pools'),
    ]);
    btns.push([Markup.button.callback('🏠 Menu', 'nav:main')]);

    return Markup.inlineKeyboard(btns);
  },
  
  // Single pool view menu
  poolView: (pool, user) => {
    const poolId = pool?.id;
    const inWatchlist = user?.watchlist?.includes(poolId);
    
    const btns = [
      [Markup.button.callback('📊 Chart', `chart:${poolId}:1h`),
       Markup.button.callback('💧 LP History', `liqhistory:${poolId}`)],
      [Markup.button.callback('🏆 Leaderboard', `leaderboard:${pool?.baseMint || pool?.base}`)],
      [Markup.button.callback(inWatchlist ? '❌ Remove from Watchlist' : '☆ Add to Watchlist', `pool:watch:${poolId}`)],
      [Markup.button.callback('🔗 Solscan', 'noop'), Markup.button.callback('🦅 Birdeye', 'noop')],
      [Markup.button.callback('« Back', 'nav:pools'), Markup.button.callback('🏠 Menu', 'nav:main')],
    ];
    
    // Replace noop with actual URLs
    if (poolId) {
      btns[3] = [
        Markup.button.url('🔗 Solscan', `https://solscan.io/account/${poolId}`),
        Markup.button.url('🦅 Birdeye', `https://birdeye.so/token/${pool?.baseMint || pool?.base}?chain=solana`),
      ];
    }
    
    return Markup.inlineKeyboard(btns);
  },
  
  // Other pools settings
  otherPoolSettings: (u) => Markup.inlineKeyboard([
    [Markup.button.callback(`${u?.trackOtherPools !== false ? '✅' : '⬜'} Track Other Pools`, 'tog:trackOtherPools')],
    [Markup.button.callback(`${u?.otherBuys ? '✅' : '⬜'} Buy Alerts`, 'tog:otherBuys'),
     Markup.button.callback(`${u?.otherSells ? '✅' : '⬜'} Sell Alerts`, 'tog:otherSells')],
    [Markup.button.callback(`${u?.otherLpAdd ? '✅' : '⬜'} LP Add`, 'tog:otherLpAdd'),
     Markup.button.callback(`${u?.otherLpRemove ? '✅' : '⬜'} LP Remove`, 'tog:otherLpRemove')],
    [Markup.button.callback(`💰 Trade Min: ${fmt(u?.otherThreshold || 500)}`, 'thresh:other')],
    [Markup.button.callback(`💧 LP Min: ${fmt(u?.otherLpThreshold || 500)}`, 'thresh:lp')],
    [Markup.button.callback('📋 Browse Pools', 'nav:pools')],
    [Markup.button.callback('🏠 Menu', 'nav:main')],
  ]),
  
  wallets: (u) => {
    const btns = [];
    const wallets = u?.wallets || [];

    if (wallets.length > 0) {
      wallets.slice(0, 5).forEach(w => {
        btns.push([
          Markup.button.callback(`👛 ${shortAddr(w)}`, `view:wallet:${w}`),
          Markup.button.callback('🗑️', `confirm:rmwhale:${w}`),
        ]);
      });
      if (wallets.length > 5) btns.push([Markup.button.callback(`📋 View All (${wallets.length})`, 'nav:allwallets')]);
    }
    
    if (wallets.length < CONFIG.maxWalletsPerUser) {
      btns.push([Markup.button.callback('➕ Add Wallet', 'input:wallet')]);
    }
    if (wallets.length > 0) {
      btns.push([Markup.button.callback(`${u?.walletAlerts ? '✅' : '⬜'} Wallet Alerts`, 'tog:walletAlerts')]);
    }
    btns.push([Markup.button.callback('🏠 Menu', 'nav:main')]);
    return Markup.inlineKeyboard(btns);
  },
  
  watchlist: (u) => {
    const btns = [];
    
    if (u?.trackOtherPools === false) {
      btns.push([Markup.button.callback('⚠️ Turn on Other Pools first', 'tog:trackOtherPools')]);
      btns.push([Markup.button.callback('🏠 Menu', 'nav:main')]);
      return Markup.inlineKeyboard(btns);
    }
    
    const tokenCount = u?.trackedTokens?.length || 0;
    const poolCount = u?.watchlist?.length || 0;
    const totalItems = tokenCount + poolCount;
    
    if (totalItems > 0) {
      (u?.trackedTokens || []).slice(0, 3).forEach(t => {
        btns.push([
          Markup.button.callback(`🪙 ${getSymbol(t)}`, `view:token:${t}`),
          Markup.button.callback('🗑️', `confirm:rmtoken:${t}`),
        ]);
      });
      
      (u?.watchlist || []).slice(0, 3).forEach(id => {
        const p = poolMap.get(id);
        btns.push([
          Markup.button.callback(`💎 ${p?.pairName || '???'}`, `view:pool:${id}`),
          Markup.button.callback('🗑️', `confirm:rmpool:${id}`),
        ]);
      });
      
      if (totalItems > 6) btns.push([Markup.button.callback(`📋 View All (${totalItems})`, 'nav:allwatchlist')]);
    }
    
    btns.push([Markup.button.callback('🔍 Search Token', 'input:search'), Markup.button.callback('📋 Browse Pools', 'browse:0')]);
    
    if (totalItems > 0) {
      btns.push([
        Markup.button.callback(`${u?.otherBuys ? '✅' : '⬜'} Buys`, 'tog:otherBuys'),
        Markup.button.callback(`${u?.otherSells ? '✅' : '⬜'} Sells`, 'tog:otherSells'),
      ]);
      btns.push([Markup.button.callback(`💰 Minimum: ${fmt(u?.otherThreshold || 500)}`, 'thresh:watch')]);
      btns.push([Markup.button.callback('🗑️ Clear All', 'confirm:clearwatchlist')]);
    }
    
    btns.push([Markup.button.callback('🏠 Menu', 'nav:main')]);
    return Markup.inlineKeyboard(btns);
  },
  
  snooze: (u) => {
    const btns = [];
    const quietActive = isQuietHoursActive(u);
    
    if (u?.snoozedUntil && Date.now() < u.snoozedUntil) {
      btns.push([Markup.button.callback('🔔 Turn Back On', 'snooze:off')]);
    } else {
      btns.push([
        Markup.button.callback('🕐 1 hour', 'snooze:60'),
        Markup.button.callback('🕓 4 hours', 'snooze:240'),
        Markup.button.callback('🕗 8 hours', 'snooze:480'),
      ]);
    }
    
    btns.push([Markup.button.callback(`🌙 Quiet Hours${quietActive ? ' (Active)' : ''}`, 'nav:quiet')]);
    btns.push([Markup.button.callback('🏠 Menu', 'nav:main')]);
    return Markup.inlineKeyboard(btns);
  },
  
  quiet: (u) => {
    const hasQuiet = u?.quietStart !== null && u?.quietEnd !== null;

    return Markup.inlineKeyboard([
      [Markup.button.callback('Set 22:00-06:00 UTC', 'quiet:22:6')],
      [Markup.button.callback('Set 23:00-07:00 UTC', 'quiet:23:7')],
      [Markup.button.callback('Set 00:00-08:00 UTC', 'quiet:0:8')],
      [Markup.button.callback(hasQuiet ? '🔔 Turn Off Quiet Hours' : '« Back', hasQuiet ? 'quiet:off' : 'nav:snooze')],
      [Markup.button.callback('🏠 Menu', 'nav:main')],
    ]);
  },
  
  history: (u) => {
    const btns = [];
    const alerts = u?.recentAlerts || [];
    
    if (alerts.length > 0) {
      alerts.slice(0, 5).forEach((a) => {
        let icon = '💧';
        if (a.type === 'trade') icon = a.isBuy ? '🟢' : '🔴';
        else if (a.type === 'wallet') icon = '🐋';
        else if (a.type === 'lp') icon = a.isAdd ? '💧' : '🔥';
        else if (a.type === 'pool_init') icon = '🆕';
        else if (a.type === 'lock') icon = '🔒';
        else if (a.type === 'unlock') icon = '🔓';
        else if (a.type === 'reward') icon = '🎁';
        else if (a.type === 'close_pool') icon = '🚫';
        else if (a.type === 'protocol_fees') icon = '💰';
        else if (a.type === 'admin') icon = '⚠️';
        const time = new Date(a.time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });
        const label = a.pair || a.token || a.wallet || '???';
        if (a.sig) {
          btns.push([Markup.button.url(`${icon} ${label} ${fmt(a.usd)} • ${time}`, `https://solscan.io/tx/${a.sig}`)]);
        } else {
          btns.push([Markup.button.callback(`${icon} ${label} ${fmt(a.usd)} • ${time}`, 'noop_alert')]);
        }
      });
    }
    
    btns.push([Markup.button.callback('🏠 Menu', 'nav:main')]);
    return Markup.inlineKeyboard(btns);
  },
  
  settings: (u) => Markup.inlineKeyboard([
    [Markup.button.callback(u?.enabled ? '⏸️ Pause All Alerts' : '▶️ Resume Alerts', 'tog:enabled')],
    [Markup.button.callback('🔷 CIPHER Settings', 'nav:cipher'), Markup.button.callback('🌐 Pool Settings', 'nav:othersettings')],
    [Markup.button.callback('💧 LP Settings', 'nav:lp'), Markup.button.callback('👛 Wallets', 'nav:wallets')],
    [Markup.button.callback(u?.newPoolAlerts !== false ? '🆕 New Pools: ON' : '🆕 New Pools: OFF', 'tog:newPoolAlerts'),
     Markup.button.callback(u?.lockAlerts !== false ? '🔒 Lock: ON' : '🔒 Lock: OFF', 'tog:lockAlerts')],
    [Markup.button.callback(u?.rewardAlerts !== false ? '🎁 Rewards: ON' : '🎁 Rewards: OFF', 'tog:rewardAlerts'),
     Markup.button.callback(u?.closePoolAlerts !== false ? '🚫 Close Pool: ON' : '🚫 Close Pool: OFF', 'tog:closePoolAlerts')],
    [Markup.button.callback(u?.protocolFeeAlerts !== false ? '💰 Fees: ON' : '💰 Fees: OFF', 'tog:protocolFeeAlerts'),
     Markup.button.callback(u?.adminAlerts !== false ? '⚠️ Admin: ON' : '⚠️ Admin: OFF', 'tog:adminAlerts')],
    [Markup.button.callback(u?.dailyDigest ? '📬 Digest: ON' : '📭 Digest: OFF', 'tog:dailyDigest')],
    [Markup.button.callback('🗑️ Reset Statistics', 'confirm:resetstats'), Markup.button.callback('❓ Help', 'info:help')],
    [Markup.button.callback('🏠 Menu', 'nav:main')],
  ]),
  
  threshold: (type, current) => {
    const opts = [50, 100, 250, 500, 1000, 2500, 5000, 10000];
    const btns = [];
    
    for (let i = 0; i < opts.length; i += 3) {
      const row = opts.slice(i, i + 3).map(v => {
        const label = v >= 1000 ? `$${v/1000}K` : `$${v}`;
        const isSelected = current === v;
        return Markup.button.callback(isSelected ? `✓ ${label}` : label, `setth:${type}:${v}`);
      });
      btns.push(row);
    }
    
    const backNavMap = { cipher: 'nav:cipher', lp: 'nav:lp', other: 'nav:othersettings', watch: 'nav:watchlist' };
    const backNav = backNavMap[type] || 'nav:main';
    btns.push([Markup.button.callback('« Back', backNav), Markup.button.callback('🏠 Menu', 'nav:main')]);
    return Markup.inlineKeyboard(btns);
  },
  
  browse: (page, u) => {
    const perPage = 5;
    const start = page * perPage;
    const slice = otherPools.slice(start, start + perPage);
    const total = Math.ceil(otherPools.length / perPage) || 1;
    
    const btns = slice.map(p => {
      const inList = u?.watchlist?.includes(p.id);
      return [Markup.button.callback(`${inList ? '✅' : '➕'} ${p.pairName}`, inList ? `rm:pool:${p.id}:browse:${page}` : `add:pool:${p.id}:browse:${page}`)];
    });
    
    const nav = [];
    if (page > 0) nav.push(Markup.button.callback('◀️ Prev', `browse:${page - 1}`));
    nav.push(Markup.button.callback(`${page + 1} / ${total}`, 'noop'));
    if (page < total - 1) nav.push(Markup.button.callback('Next ▶️', `browse:${page + 1}`));
    btns.push(nav);
    btns.push([Markup.button.callback('« Back', 'nav:watchlist'), Markup.button.callback('🏠 Menu', 'nav:main')]);
    return Markup.inlineKeyboard(btns);
  },
  
  searchResults: (results, u) => {
    const btns = results.map(p => {
      const inList = u?.watchlist?.includes(p.id);
      return [Markup.button.callback(`${inList ? '✅' : '➕'} ${p.pairName}`, inList ? `rm:pool:${p.id}` : `add:pool:${p.id}`)];
    });
    btns.push([Markup.button.callback('🔍 New Search', 'input:search')]);
    btns.push([Markup.button.callback('« Back', 'nav:watchlist'), Markup.button.callback('🏠 Menu', 'nav:main')]);
    return Markup.inlineKeyboard(btns);
  },
  
  tokenPools: (mint, u) => {
    const tokenPools = findPoolsByToken(mint);
    const btns = tokenPools.slice(0, 5).map(p => {
      const inList = u?.watchlist?.includes(p.id);
      return [Markup.button.callback(`${inList ? '✅' : '➕'} ${p.pairName}`, inList ? `rm:pool:${p.id}` : `add:pool:${p.id}`)];
    });
    
    if (tokenPools.length > 1) btns.push([Markup.button.callback(`➕ Add All ${tokenPools.length} Pools`, `addall:${mint}`)]);
    
    const isTracked = u?.trackedTokens?.includes(mint);
    btns.push([Markup.button.callback(isTracked ? '🔕 Stop Tracking Token' : '🔔 Track This Token', isTracked ? `rm:token:${mint}` : `add:token:${mint}`)]);
    btns.push([
      Markup.button.url('📊 Chart', `https://dexscreener.com/solana/${mint}`),
      Markup.button.url('🔍 Solscan', `https://solscan.io/token/${mint}`),
    ]);
    btns.push([Markup.button.callback('« Back', 'nav:watchlist'), Markup.button.callback('🏠 Menu', 'nav:main')]);
    return Markup.inlineKeyboard(btns);
  },
  
  confirm: (action, label) => Markup.inlineKeyboard([
    [Markup.button.callback(`✅ Yes, ${label}`, `do:${action}`)],
    [Markup.button.callback('❌ Cancel', 'nav:main')],
  ]),
  
  alertActions: (poolId, sig) => Markup.inlineKeyboard([
    [Markup.button.url('🔍 View on Solscan', `https://solscan.io/tx/${sig}`)],
    [Markup.button.callback('➕ Add to Watchlist', `add:pool:${poolId}:alert`), Markup.button.callback('🔕 Snooze 1h', 'snooze:alert:60')],
  ]),
  
  walletAlertActions: (sig) => Markup.inlineKeyboard([
    [Markup.button.url('🔍 View on Solscan', `https://solscan.io/tx/${sig}`)],
    [Markup.button.callback('🔕 Snooze 1h', 'snooze:alert:60')],
  ]),
  
  // Portfolio menus
  portfolio: (u) => {
    const walletList = u?.portfolioWallets || [];
    const hasWallets = walletList.length > 0 || !!u?.myWallet;
    const walletCount = walletList.length || (u?.myWallet ? 1 : 0);
    const btns = [];
    
    if (hasWallets) {
      btns.push([
        Markup.button.callback('📊 Stats', 'portfolio:stats'),
        Markup.button.callback('🪙 Tokens', 'portfolio:tokens'),
      ]);
      btns.push([
        Markup.button.callback('💧 LP', 'portfolio:lp'),
        Markup.button.callback('📜 Trades', 'portfolio:trades'),
      ]);
      btns.push([
        Markup.button.callback('🔄 Refresh', 'portfolio:sync'),
        Markup.button.callback(`👛 Wallets (${walletCount})`, 'portfolio:wallets'),
      ]);
      
      // Quick links for first wallet
      const firstWallet = u.myWallet || walletList[0];
      if (firstWallet) {
        btns.push([
          Markup.button.url('🔍 Solscan', `https://solscan.io/account/${firstWallet}`),
          Markup.button.url('🦅 Birdeye', `https://birdeye.so/profile/${firstWallet}?chain=solana`),
        ]);
      }
    } else {
      btns.push([Markup.button.callback('➕ Add Wallet', 'portfolio:addwallet')]);
    }
    
    btns.push([Markup.button.callback('🏠 Menu', 'nav:main')]);
    return Markup.inlineKeyboard(btns);
  },

  // Portfolio wallet management menu
  portfolioWallets: (u) => {
    const walletList = u?.portfolioWallets || [];
    if (u?.myWallet && !walletList.includes(u.myWallet)) {
      walletList.unshift(u.myWallet);
    }
    const btns = [];
    
    if (walletList.length > 0) {
      walletList.slice(0, 5).forEach((w, i) => {
        const addr = w.slice(0, 4) + '...' + w.slice(-4);
        const p = u?.portfolio?.walletData?.[w] || {};
        const value = p.value ? ` • ${fmt(p.value)}` : '';
        btns.push([
          Markup.button.callback(`${i === 0 ? '⭐' : '👛'} ${addr}${value}`, `portfolio:view:${w}`),
          Markup.button.callback('🗑️', `portfolio:rmwallet:${w}`),
        ]);
      });
    }
    
    if (walletList.length < 5) {
      btns.push([Markup.button.callback('➕ Add Wallet', 'portfolio:addwallet')]);
    }
    
    btns.push([Markup.button.callback('« Back', 'nav:portfolio'), Markup.button.callback('🏠 Menu', 'nav:main')]);
    return Markup.inlineKeyboard(btns);
  },
  
  portfolioLp: (positions, page = 0) => {
    if (!positions || positions.length === 0) {
      return Markup.inlineKeyboard([
        [Markup.button.callback('➕ Add Wallet', 'portfolio:addwallet')],
        [Markup.button.callback('« Back', 'nav:portfolio'), Markup.button.callback('🏠 Menu', 'nav:main')]
      ]);
    }
    const pageSize = 8;
    const start = page * pageSize;
    const pagePositions = positions.slice(start, start + pageSize);
    const totalPages = Math.ceil(positions.length / pageSize);

    const btns = pagePositions.map(pos => {
      return [
        Markup.button.callback(
          `${pos.isCipher ? '🔷' : '💧'} ${pos.pool} • ${fmt(pos.valueUsd)}`,
          `view:lp:${pos.poolId}`
        )
      ];
    });

    if (totalPages > 1) {
      const navBtns = [];
      if (page > 0) navBtns.push(Markup.button.callback('«', `portfolio:lp:${page - 1}`));
      navBtns.push(Markup.button.callback(`${page + 1}/${totalPages}`, 'noop'));
      if (page < totalPages - 1) navBtns.push(Markup.button.callback('»', `portfolio:lp:${page + 1}`));
      btns.push(navBtns);
    }
    btns.push([Markup.button.callback('🔄 Refresh', 'portfolio:sync'), Markup.button.callback('« Back', 'nav:portfolio')]);
    btns.push([Markup.button.callback('🏠 Menu', 'nav:main')]);
    return Markup.inlineKeyboard(btns);
  },
  
  portfolioTrades: (trades, page = 0) => {
    if (!trades || trades.length === 0) {
      return Markup.inlineKeyboard([
        [Markup.button.callback('« Back', 'nav:portfolio'), Markup.button.callback('🏠 Menu', 'nav:main')]
      ]);
    }
    
    const pageSize = 5;
    const start = page * pageSize;
    const pageTrades = trades.slice(start, start + pageSize);
    const totalPages = Math.ceil(trades.length / pageSize);
    
    const btns = pageTrades.map(t => {
      const icon = t.side === 'buy' ? '🟢' : '🔴';
      const time = new Date(t.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
      return [Markup.button.url(`${icon} ${t.pool} • ${fmt(t.usd)} • ${time}`, `https://solscan.io/tx/${t.sig}`)];
    });
    
    if (totalPages > 1) {
      const navBtns = [];
      if (page > 0) navBtns.push(Markup.button.callback('«', `portfolio:trades:${page - 1}`));
      navBtns.push(Markup.button.callback(`${page + 1}/${totalPages}`, 'noop'));
      if (page < totalPages - 1) navBtns.push(Markup.button.callback('»', `portfolio:trades:${page + 1}`));
      btns.push(navBtns);
    }
    
    btns.push([Markup.button.callback('« Back', 'nav:portfolio'), Markup.button.callback('🏠 Menu', 'nav:main')]);
    return Markup.inlineKeyboard(btns);
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// TEXTS
// ═══════════════════════════════════════════════════════════════════════════════
const text = {
  welcome: (name) => `🚀 *Orbit Tracker*${name ? `\n\nWelcome, ${name}!` : ''}

Your complete Orbit Finance companion.

*What you'll get:*
• 🔷 CIPHER trade & LP alerts
• 🌐 Pool Explorer with trending & new pools
• 👛 Whale wallet tracking
• 📈 Portfolio & PnL analytics
• 📊 Charts & leaderboards
• ⭐ Custom watchlists`,

  dashboard: (u, name) => {
    const today = u?.todayStats || { trades: 0, lp: 0, wallet: 0 };
    const watchCount = (u?.watchlist?.length || 0) + (u?.trackedTokens?.length || 0);
    const walletCount = u?.wallets?.length || 0;
    const snoozed = isUserSnoozed(u);
    const quietActive = isQuietHoursActive(u);

    let status = '🟢 Active';
    if (!u?.enabled) status = '⏸️ Paused';
    else if (snoozed) status = quietActive ? '🌙 Quiet Hours' : '🔕 Snoozed';

    const solPrice = getPrice(MINTS.SOL);
    const priceDisplay = solPrice ? `$${solPrice.toFixed(2)}` : 'Loading...';
    const vol24h = orbitVolumes.total24h ? fmt(orbitVolumes.total24h) : '-';

    // Enhanced portfolio summary
    const hasPortfolio = !!u?.myWallet;
    let portfolioLine = '';
    if (hasPortfolio) {
      const p = u.portfolio || {};
      const netWorth = p.totalValue || 0;
      const pnl = p.realizedPnl || 0;
      const pnlIcon = pnl >= 0 ? '🟢' : '🔴';
      portfolioLine = `\n📈 Portfolio: ${fmt(netWorth)} • ${pnlIcon} ${pnl >= 0 ? '+' : '-'}${fmt(Math.abs(pnl))} PnL`;
    }

    const greeting = name ? `\nWelcome back, ${name}!` : '';

    return `📊 *Dashboard*${greeting}

*Status:* ${status}

*Tracking:*
🔷 CIPHER ${u?.cipherBuys || u?.cipherSells ? '✓' : '✗'} trades, ${u?.cipherLpAdd || u?.cipherLpRemove ? '✓' : '✗'} LP
👛 ${walletCount} wallet${walletCount !== 1 ? 's' : ''} ${u?.walletAlerts ? '✓' : '✗'}
⭐ ${watchCount} watchlist item${watchCount !== 1 ? 's' : ''}${portfolioLine}

*Today:* ${today.trades} trades, ${today.lp} LP, ${today.wallet} wallet
*Tracked volume:* ${fmt(u?.stats?.volume || 0)}

_SOL: ${priceDisplay} • Orbit 24h: ${vol24h}_`;
  },
  
  about: () => `🚀 *About Orbit Tracker*

Your all-in-one companion for Orbit Finance.

*Portfolio Tracking*
Track up to 5 wallets with combined net worth, PnL, LP positions, and trade history — all powered by Birdeye data.

*Whale Alerts*
Get notified for CIPHER trades, LP events, and activity from wallets you follow.

*Watchlists*
Create custom lists of tokens and pools to monitor with customizable thresholds.

*Smart Notifications*
Snooze alerts, set quiet hours, or pause entirely — you're in control.

_No wallet connection required. Read-only. Safe._`,

  help: () => `📚 *Orbit Tracker Help*

*Portfolio:*
/portfolio — View your portfolio
/pnl — Quick PnL summary
/lp — View LP positions
/refresh — Sync portfolio data
/wallets — Manage tracked wallets

*Pool Explorer:*
/pools — Browse all pools
/trending — Top pools by volume
/newpools — Recently added pools

*Market Info:*
/price — SOL & CIPHER prices
/cipher — CIPHER token stats
/chart — Price chart (try /chart CIPHER 1h)
/leaderboard — Top traders PnL
/liquidity — LP event history

*Alerts:*
/pause — Pause all alerts
/resume — Resume alerts
/snooze — Snooze for 1 hour
/settings — Pool close, protocol fee, admin alerts

*Settings:*
/settings — Alert preferences
/stats — Your usage stats
/status — Bot & API status
/menu — Open main menu

*Tips:*
• Track up to 5 wallets in portfolio
• Set higher minimums for fewer alerts
• Use quiet hours for overnight
• Track whale wallets to copy trades

*Need help?*
[@cipherlabsx](https://x.com/cipherlabsx)`,

  cipher: (u) => `🔷 *CIPHER Alerts*

Get notified for CIPHER pool activity.

*Current settings:*
• Buys: ${u?.cipherBuys ? 'ON' : 'OFF'}
• Sells: ${u?.cipherSells ? 'ON' : 'OFF'}
• LP Add: ${u?.cipherLpAdd ? 'ON' : 'OFF'}
• LP Remove: ${u?.cipherLpRemove ? 'ON' : 'OFF'}
• Minimum: ${fmt(u?.cipherThreshold || 100)}`,
  
  lp: (u) => `💧 *LP Alerts*

Get notified when liquidity is added or removed.

*Current settings:*
• LP Add: ${u?.otherLpAdd ? 'ON' : 'OFF'}
• LP Remove: ${u?.otherLpRemove ? 'ON' : 'OFF'}
• Minimum: ${fmt(u?.otherLpThreshold || 500)}`,

  wallets: (u) => {
    const count = u?.wallets?.length || 0;
    if (count === 0) {
      return `👛 *Wallet Tracking*

Follow whale wallets and get alerts when they trade on Orbit.

Tap *Add Wallet* to get started.`;
    }
    return `👛 *Wallet Tracking*

You're tracking *${count}* wallet${count !== 1 ? 's' : ''}.
Alerts: ${u?.walletAlerts ? '✅ ON' : '⬜ OFF'}`;
  },

  watchlist: (u) => {
    const count = (u?.watchlist?.length || 0) + (u?.trackedTokens?.length || 0);
    if (count === 0) {
      return `⭐ *Watchlist*

Track specific tokens and pools.

Use *Search* to find tokens by name or address, or *Browse* to see all pools.`;
    }
    return `⭐ *Watchlist*

Tracking *${count}* item${count !== 1 ? 's' : ''}.`;
  },
  
  // Pool Explorer texts
  pools: (sortBy = 'volume') => {
    const total = pools.length;
    const cipherCount = cipherPools.length;
    const otherCount = otherPools.length;
    const totalVol = orbitVolumes.total24h || 0;
    
    return `🌐 *Pool Explorer*

*${total} pools* on Orbit Finance
🔷 ${cipherCount} CIPHER pools
🌐 ${otherCount} other pools

📊 *24h Volume:* ${fmtCompact(totalVol)}

_Sorted by ${sortBy === 'volume' ? '24h Volume' : sortBy === 'tvl' ? 'TVL' : 'Trade Count'}_`;
  },
  
  trending: () => {
    const totalVol = orbitVolumes.total24h || 0;
    const topPools = getTopPoolsByVolume(10);
    if (topPools.length === 0) {
      return `🔥 *Trending Pools*

No trading activity recorded yet. Check back soon!`;
    }
    return `🔥 *Trending Pools*

Top pools by 24h trading volume.

📊 *Total 24h Volume:* ${fmtCompact(totalVol)}

_Tap a pool for details, charts, and leaderboards._`;
  },
  
  poolView: (pool) => {
    if (!pool) return `❌ Pool not found`;
    
    const pairName = pool.pairName || formatPair(pool.baseMint || pool.base, pool.quoteMint || pool.quote);
    const vol24h = orbitVolumes.pools?.[pool.id]?.volume24h || 0;
    const trades24h = orbitVolumes.pools?.[pool.id]?.trades24h || 0;
    const tvl = pool.tvl || pool.liquidity || 0;
    const fee = pool.fee || pool.feeRate || 0;
    const baseFee = pool.baseFee || pool.base_fee || 0;
    const maxFee = pool.maxFee || pool.max_fee || 0;
    const protocolFee = pool.protocolFee || pool.protocol_fee || 0;
    const icon = pool.isCipher ? '🔷' : '🌐';

    // Get base token price
    const baseMint = pool.baseMint || pool.base;
    const basePrice = getPrice(baseMint) || 0;
    const priceStr = basePrice > 0 ? `$${basePrice < 0.01 ? basePrice.toFixed(6) : basePrice.toFixed(4)}` : 'N/A';

    // Build fee display - show breakdown if available
    let feeStr = 'N/A';
    if (fee > 0) {
      feeStr = `${(fee * 100).toFixed(2)}%`;
    }
    if (baseFee > 0 || maxFee > 0) {
      const parts = [];
      if (baseFee > 0) parts.push(`Base ${(baseFee * 100).toFixed(2)}%`);
      if (maxFee > 0) parts.push(`Max ${(maxFee * 100).toFixed(2)}%`);
      if (protocolFee > 0) parts.push(`Protocol ${(protocolFee * 100).toFixed(2)}%`);
      if (parts.length > 0) feeStr += ` (${parts.join(' · ')})`;
    }

    return `${icon} *${escMd(pairName)}*

💵 *Price:* ${priceStr}
📊 *24h Volume:* ${fmtCompact(vol24h)}
🔄 *24h Trades:* ${trades24h}
💰 *TVL:* ${fmtCompact(tvl)}
💸 *Fee:* ${feeStr}

\`${pool.id}\``;
  },
  
  otherPoolSettings: (u) => {
    const alerts = [];
    if (u?.otherBuys) alerts.push('Buys');
    if (u?.otherSells) alerts.push('Sells');
    if (u?.otherLpAdd) alerts.push('LP+');
    if (u?.otherLpRemove) alerts.push('LP-');
    const alertStr = alerts.length > 0 ? alerts.join(', ') : 'None';
    
    return `🌐 *Other Pools Settings*

*Status:* ${u?.trackOtherPools !== false ? '✅ Tracking' : '⬜ Disabled'}
*Alerts:* ${alertStr}
*Trade Minimum:* ${fmt(u?.otherThreshold || 500)}
*LP Minimum:* ${fmt(u?.otherLpThreshold || 500)}

_Configure alerts for all non-CIPHER pools on Orbit._`;
  },
  
  snooze: (u) => {
    const quietActive = isQuietHoursActive(u);
    if (quietActive) {
      return `🔕 *Alert Controls*

🌙 *Quiet hours active* — alerts paused until ${u.quietEnd}:00 UTC`;
    }
    if (u?.snoozedUntil && Date.now() < u.snoozedUntil) {
      const mins = Math.round((u.snoozedUntil - Date.now()) / 60000);
      return `🔕 *Alert Controls*

⏰ *Snoozed* — alerts paused for ${mins} more minute${mins !== 1 ? 's' : ''}`;
    }
    return `🔕 *Alert Controls*

Temporarily pause alerts or set up quiet hours.`;
  },
  
  quiet: (u) => {
    const hasQuiet = u?.quietStart !== null && u?.quietEnd !== null;
    const current = hasQuiet ? `\n\n*Current:* ${u.quietStart}:00 — ${u.quietEnd}:00 UTC` : '';
    return `🌙 *Quiet Hours*

Set hours when you don't want to receive alerts (all times in UTC).${current}`;
  },
  
  history: (u) => {
    const count = u?.recentAlerts?.length || 0;
    if (count === 0) return `📜 *Recent Alerts*

No alerts yet. They'll appear here as you receive them.`;
    return `📜 *Recent Alerts*

Your last ${count} alert${count !== 1 ? 's' : ''}. Tap to view on Solscan.`;
  },
  
  settings: (u) => {
    const alertStatus = u?.enabled ? (isUserSnoozed(u) ? '🔕 Snoozed' : '🔔 Active') : '⏸️ Paused';
    const cipherAlerts = [
      u?.cipherBuys ? 'Buys' : null,
      u?.cipherSells ? 'Sells' : null,
      u?.cipherLpAdd ? 'LP+' : null,
      u?.cipherLpRemove ? 'LP-' : null,
    ].filter(Boolean).join(', ') || 'None';
    
    return `⚙️ *Settings*

*Alert Status:* ${alertStatus}
*Daily Digest:* ${u?.dailyDigest ? '📬 ON (9:00 UTC)' : '📭 OFF'}
*CIPHER Alerts:* ${cipherAlerts}
*Min Amount:* ${fmt(u?.cipherThreshold || 100)}
*Other Pools:* ${u?.trackOtherPools !== false ? 'ON' : 'OFF'}
*Wallet Alerts:* ${u?.walletAlerts ? 'ON' : 'OFF'}
*New Pools:* ${u?.newPoolAlerts !== false ? '🆕 ON' : 'OFF'}
*Lock/Unlock:* ${u?.lockAlerts !== false ? '🔒 ON' : 'OFF'}
*Rewards:* ${u?.rewardAlerts !== false ? '🎁 ON' : 'OFF'}
*Close Pool:* ${u?.closePoolAlerts !== false ? '🚫 ON' : 'OFF'}
*Protocol Fees:* ${u?.protocolFeeAlerts !== false ? '💰 ON' : 'OFF'}
*Admin:* ${u?.adminAlerts !== false ? '⚠️ ON' : 'OFF'}

*Tracked:*
• ${u?.wallets?.length || 0} whale wallets
• ${(u?.watchlist?.length || 0) + (u?.trackedTokens?.length || 0)} watchlist items
• ${u?.portfolioWallets?.length || (u?.myWallet ? 1 : 0)} portfolio wallets`;
  },

  search: () => `🔍 *Search*

Enter a token name (e.g. "SOL") or paste a contract address:`,

  addWallet: () => `👛 *Add Wallet*

Paste a Solana wallet address to track:`,

  status: () => {
    const uptime = Math.floor((Date.now() - botStartTime) / 60000);
    const h = Math.floor(uptime / 60);
    const m = uptime % 60;
    const solPrice = getPrice(MINTS.SOL);
    const cipherPrice = getPrice(MINTS.CIPHER);
    const priceAge = lastPriceUpdate > 0 ? Math.floor((Date.now() - lastPriceUpdate) / 60000) : -1;
    
    // Price source
    let priceSource = '🔴 Not loaded';
    if (priceApiStatus === 'jupiter') priceSource = '🟢 Jupiter';
    else if (priceApiStatus === 'dexscreener') priceSource = '🟡 DexScreener';
    else if (priceApiStatus === 'birdeye') priceSource = '🟡 Birdeye';
    else if (priceApiStatus === 'coingecko') priceSource = '🟡 CoinGecko';
    else if (priceApiStatus === 'error') priceSource = '🔴 All failed';
    
    // API health indicators
    const getHealthIcon = (api) => {
      const h = apiHealth[api];
      if (!h || h.status === 'unknown') return '⚪';
      if (h.status === 'ok') return '🟢';
      if (h.status === 'degraded') return '🟡';
      return '🔴';
    };
    
    return `📡 *Bot Status*

*Uptime:* ${h}h ${m}m
*Pools:* ${cipherPools.length} CIPHER, ${otherPools.length} other
*Users:* ${users.size}
*Tracked wallets:* ${getAllTrackedWallets().length}
*Tokens cached:* ${tokens.size}
*Orbit 24h vol:* ${orbitVolumes.total24h ? fmt(orbitVolumes.total24h) : 'N/A'}

*Prices:* ${priceSource}
SOL: ${solPrice ? `$${solPrice.toFixed(2)}` : 'N/A'}
CIPHER: ${cipherPrice ? fmtPrice(cipherPrice) : 'N/A'}
${priceAge >= 0 ? `_Updated ${priceAge}m ago_` : ''}

*API Health:*
${getHealthIcon('orbit')} Orbit
${getHealthIcon('helius')} Helius
${getHealthIcon('jupiter')} Jupiter
${getHealthIcon('birdeye')} Birdeye
${getHealthIcon('solscan')} Solscan

*SDKs:*
${helius ? '🟢' : '🔴'} Helius SDK
🟢 Solana Web3.js

*Data Feed:*
${orbitWs?.readyState === 1 ? '🟢 WebSocket' : '🟡 Polling'} Orbit
${heliusWs?.readyState === 1 ? '🟢 WebSocket' : '🔴 Down'} Helius`;
  },
  
  // Portfolio texts
  portfolio: (u) => {
    // Get wallet list
    const walletList = u?.portfolioWallets || [];
    const hasWallets = walletList.length > 0 || !!u?.myWallet;
    
    if (!hasWallets) {
      return `📈 *My Portfolio*

Track your Solana wallets:
• 💎 Total net worth
• 💰 Token balances
• 💧 LP positions
• 📊 Trading stats

_Add up to 5 wallets_`;
    }
    
    const p = u.portfolio || {};
    const lastSync = p.lastSync ? new Date(p.lastSync).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }) : 'Never';
    
    // Balances - ensure we have numbers
    const solBalance = parseFloat(p.solBalance) || 0;
    const solPrice = getSolPrice() || 0;
    const solValue = parseFloat(p.solValue) || (solBalance * solPrice);
    const tokenValue = parseFloat(p.totalTokenValue) || 0;
    const lpValue = parseFloat(p.lpValue) || 0;
    const stakedValue = parseFloat(p.totalStakedValue) || 0;
    const totalValue = parseFloat(p.totalValue) || (solValue + tokenValue + lpValue + stakedValue);
    
    // Wallet display
    const walletCount = p.walletCount || walletList.length || 1;
    const primaryWallet = u.myWallet || walletList[0] || '';
    const walletsDisplay = walletCount === 1 
      ? (primaryWallet ? `\`${primaryWallet.slice(0, 4)}...${primaryWallet.slice(-4)}\`` : '1 wallet')
      : `${walletCount} wallets`;
    
    // PnL display - ensure we have numbers
    const realizedPnl = parseFloat(p.realizedPnl) || 0;
    const pnlIcon = realizedPnl >= 0 ? '🟢' : '🔴';
    const pnlSign = realizedPnl >= 0 ? '+' : '-';

    // Build holdings breakdown - only show if > 0
    let holdingsText = '';
    if (solBalance > 0) {
      const solDisplay = solBalance >= 1 ? solBalance.toFixed(2) : solBalance.toFixed(4);
      holdingsText += `◎ SOL: ${solDisplay} (${fmt(solValue)})\n`;
    }
    if (tokenValue > 0) holdingsText += `🪙 Tokens: ${fmt(tokenValue)} (${p.tokenCount || 0})\n`;
    if (lpValue > 0) holdingsText += `💧 LP: ${fmt(lpValue)} (${p.lpPositions?.length || 0})\n`;
    
    // Show staked CIPHER - even if value is 0, show the sCIPHER balance
    const scipherBalance = parseFloat(p.totalScipherBalance) || 0;
    if (stakedValue > 0) {
      holdingsText += `🔒 Staked: ${fmt(stakedValue)}\n`;
    } else if (scipherBalance > 0) {
      // Show sCIPHER balance even if value couldn't be calculated
      holdingsText += `🔒 Staked: ${fmtSupply(scipherBalance)} sCIPHER\n`;
    }
    
    if (!holdingsText) holdingsText = '_Syncing..._\n';
    
    // Trade stats
    const tradeCount = parseInt(p.tradeCount) || 0;
    const totalVolume = parseFloat(p.totalVolume) || 0;
    
    return `📈 *Portfolio* — ${walletsDisplay}

💎 *Net Worth:* ${fmt(totalValue)}

${holdingsText}
📊 *Trading:*
${pnlIcon} PnL: ${pnlSign}${fmt(Math.abs(realizedPnl))}
💰 Volume: ${fmt(totalVolume)}
🔄 Trades: ${tradeCount}

_${lastSync} UTC_`;
  },
  
  portfolioStats: (u) => {
    const p = u?.portfolio || {};
    const walletList = u?.portfolioWallets || [];
    const walletCount = p.walletCount || walletList.length || 1;
    
    // Balances from portfolio data - ensure numbers
    const solBalance = parseFloat(p.solBalance) || 0;
    const solPrice = getSolPrice() || 0;
    const solValue = parseFloat(p.solValue) || (solBalance * solPrice);
    const tokenValue = parseFloat(p.totalTokenValue) || 0;
    const lpValue = parseFloat(p.lpValue) || 0;
    const stakedValue = parseFloat(p.totalStakedValue) || 0;
    const stakedCipher = parseFloat(p.totalStakedCipher) || 0;
    const scipherBalance = parseFloat(p.totalScipherBalance) || 0;
    const totalValue = parseFloat(p.totalValue) || (solValue + tokenValue + lpValue + stakedValue);
    
    // PnL - ensure numbers
    const realizedPnl = parseFloat(p.realizedPnl) || 0;
    const unrealizedPnl = parseFloat(p.unrealizedPnl) || 0;
    const totalVolume = parseFloat(p.totalVolume) || 0;
    const pnlPercent = totalVolume > 0 ? ((realizedPnl / totalVolume) * 100).toFixed(1) : '0.0';
    const pnlIcon = realizedPnl >= 0 ? '🟢' : '🔴';
    
    // Counts
    const tradeCount = parseInt(p.tradeCount) || 0;
    const buyCount = parseInt(p.buyCount) || 0;
    const sellCount = parseInt(p.sellCount) || 0;
    const tokenCount = parseInt(p.tokenCount) || 0;
    const lpCount = p.lpPositions?.length || 0;
    
    // Top tokens display
    let topTokensText = '';
    const topTokens = (p.tokens || []).slice(0, 5);
    if (topTokens.length > 0) {
      topTokensText = '\n*Top Holdings:*\n';
      for (const token of topTokens) {
        const usd = parseFloat(token.totalUsd) || 0;
        if (usd >= 1) {
          const symbol = token.symbol || '???';
          topTokensText += `• ${escMd(symbol)}: ${fmt(usd)}\n`;
        }
      }
    }
    
    // Staked CIPHER section
    let stakedSection = '';
    if (scipherBalance > 0) {
      const source = p.stakedPositions?.[0]?.source;
      const sourceNote = source === 'vault_share' ? ' _(est)_' : '';
      stakedSection = `
*Staked CIPHER:*
🔒 ${fmtSupply(stakedCipher)} CIPHER${sourceNote} (${fmt(stakedValue)})
📜 ${fmtSupply(scipherBalance)} sCIPHER
`;
    }
    
    // Wallet breakdown for multi-wallet
    let walletBreakdown = '';
    if (walletCount > 1 && p.walletData) {
      walletBreakdown = '\n*Per Wallet:*\n';
      const wallets = Object.entries(p.walletData).slice(0, 5);
      for (const [addr, data] of wallets) {
        const shortAddr = addr.slice(0, 4) + '...' + addr.slice(-4);
        const walletValue = parseFloat(data?.value) || 0;
        walletBreakdown += `• \`${shortAddr}\`: ${fmt(walletValue)}\n`;
      }
    }
    
    // SOL balance display - handle small amounts
    const solDisplay = solBalance >= 1 ? solBalance.toFixed(4) : solBalance.toFixed(6);
    
    return `📊 *Portfolio Stats*

*${walletCount} wallet${walletCount !== 1 ? 's' : ''} tracked*

*💎 Net Worth: ${fmt(totalValue)}*

*Holdings Breakdown:*
◎ SOL: ${solDisplay} (${fmt(solValue)})
🪙 Tokens: ${fmt(tokenValue)} (${tokenCount})
💧 LP: ${fmt(lpValue)} (${lpCount})
${stakedSection}${topTokensText}
*Trading Performance:*
📈 Volume: ${fmt(totalVolume)}
🔄 Trades: ${tradeCount} (🟢 ${buyCount} / 🔴 ${sellCount})
${pnlIcon} Realized: ${realizedPnl >= 0 ? '+' : '-'}${fmt(Math.abs(realizedPnl))} (${pnlPercent}%)
${unrealizedPnl !== 0 ? `📉 Unrealized: ${unrealizedPnl >= 0 ? '+' : '-'}${fmt(Math.abs(unrealizedPnl))}\n` : ''}${walletBreakdown}`;
  },
  
  portfolioTokens: (tokens, totalValue) => {
    if (!tokens || tokens.length === 0) {
      return `🪙 *Token Holdings*

No token balances found.

_Tap Refresh to sync, or check /status for API health._`;
    }
    
    let list = '';
    for (const token of tokens.slice(0, 15)) {
      const symbol = token.symbol || '???';
      const balance = parseFloat(token.balance) || 0;
      const usd = parseFloat(token.totalUsd) || 0;
      const price = parseFloat(token.pricePerToken) || 0;
      
      // Format balance based on size
      let balanceStr;
      if (balance >= 1000000) balanceStr = fmtSupply(balance);
      else if (balance >= 1) balanceStr = balance.toFixed(2);
      else if (balance >= 0.0001) balanceStr = balance.toFixed(4);
      else balanceStr = balance.toFixed(6);
      
      const valueStr = usd >= 1 ? fmt(usd) : usd > 0 ? '<$1' : '$0';
      const priceStr = price > 0 ? ` @ ${fmtPrice(price)}` : '';
      
      list += `• *${escMd(symbol)}*: ${balanceStr} (${valueStr})${priceStr}\n`;
    }
    
    if (tokens.length > 15) {
      list += `\n_+${tokens.length - 15} more tokens_`;
    }
    
    const total = parseFloat(totalValue) || 0;
    
    return `🪙 *Token Holdings*

*Total Value:* ${fmt(total)}
*Tokens:* ${tokens.length}

${list}`;
  },
  
  portfolioLp: (positions) => {
    if (!positions || positions.length === 0) {
      return `💧 *LP Positions*

No LP positions found.

_Tap Refresh to sync your data._`;
    }
    
    const total = positions.reduce((sum, p) => sum + (p.valueUsd || 0), 0);
    const cipherCount = positions.filter(p => p.isCipher).length;
    const otherCount = positions.length - cipherCount;
    
    return `💧 *LP Positions*

*Total Value:* ${fmt(total)}
*Positions:* ${positions.length} (🔷 ${cipherCount} CIPHER, 🌐 ${otherCount} other)`;
  },
  
  portfolioTrades: (trades) => {
    if (!trades || trades.length === 0) {
      return `📜 *Trade History*

No Orbit trades found yet.

_Tap Refresh to sync, or check back after your wallets have traded on Orbit._`;
    }
    
    const buys = trades.filter(t => t.side === 'buy');
    const sells = trades.filter(t => t.side === 'sell');
    const buyVol = buys.reduce((sum, t) => sum + (t.usd || 0), 0);
    const sellVol = sells.reduce((sum, t) => sum + (t.usd || 0), 0);
    const totalVol = buyVol + sellVol;
    
    // Get unique wallets
    const uniqueWallets = [...new Set(trades.map(t => t.wallet).filter(Boolean))];
    const walletInfo = uniqueWallets.length > 1 ? `\n_Across ${uniqueWallets.length} wallets_` : '';
    
    return `📜 *Trade History*

*Total:* ${trades.length} trades • ${fmt(totalVol)} volume

🟢 *Buys:* ${buys.length} trades • ${fmt(buyVol)}
🔴 *Sells:* ${sells.length} trades • ${fmt(sellVol)}
${walletInfo}`;
  },
  
  setWallet: () => `➕ *Add Wallet*

Paste a Solana wallet address:`,
};

// ═══════════════════════════════════════════════════════════════════════════════
// COMMANDS
// ═══════════════════════════════════════════════════════════════════════════════
bot.command('start', async (ctx) => {
  try {
    let user = getUser(ctx.chat.id) || createUser(ctx.chat.id);
    const name = ctx.from?.first_name || '';
    if (!user.onboarded) {
      await ctx.reply(text.welcome(name), { parse_mode: 'Markdown', ...menu.welcome() });
    } else {
      await ctx.reply(text.dashboard(user, name), { parse_mode: 'Markdown', ...menu.main(user) });
    }
  } catch (e) {
    try { await ctx.reply('🚀 Welcome to Orbit Tracker! Tap Get Started.', { ...menu.welcome() }); } catch (e2) {}
  }
});

bot.command('menu', async (ctx) => {
  try {
    const user = getUser(ctx.chat.id) || createUser(ctx.chat.id);
    await ctx.reply(text.dashboard(user), { parse_mode: 'Markdown', ...menu.main(user) });
  } catch (e) {
    try { await ctx.reply('❌ Something went wrong.', { ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Menu', 'nav:main')]]) }); } catch (e2) {}
  }
});

bot.command('status', async (ctx) => {
  try {
    await ctx.reply(text.status(), { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Menu', 'nav:main')]]) });
  } catch (e) {
    try { await ctx.reply('❌ Failed to load status.', { ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Menu', 'nav:main')]]) }); } catch (e2) {}
  }
});

bot.command('pause', async (ctx) => {
  try {
    updateUser(ctx.chat.id, { enabled: false });
    await ctx.reply('⏸️ Alerts paused. Use /resume to turn back on.', { ...Markup.inlineKeyboard([[Markup.button.callback('▶️ Resume', 'tog:enabled'), Markup.button.callback('🏠 Menu', 'nav:main')]]) });
  } catch (e) {
    try { await ctx.reply('❌ Failed to pause alerts.', { ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Menu', 'nav:main')]]) }); } catch (e2) {}
  }
});

bot.command('resume', async (ctx) => {
  try {
    updateUser(ctx.chat.id, { enabled: true, snoozedUntil: 0 });
    await ctx.reply('▶️ Alerts resumed!', { ...Markup.inlineKeyboard([[Markup.button.callback('⚙️ Settings', 'nav:settings'), Markup.button.callback('🏠 Menu', 'nav:main')]]) });
  } catch (e) {
    try { await ctx.reply('❌ Failed to resume alerts.', { ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Menu', 'nav:main')]]) }); } catch (e2) {}
  }
});

bot.command('snooze', async (ctx) => {
  try {
    const user = getUser(ctx.chat.id);
    if (user) {
      updateUser(ctx.chat.id, { snoozedUntil: Date.now() + 3600000 });
      await ctx.reply('🔕 Snoozed for 1 hour. Use /resume to turn back on.', { ...Markup.inlineKeyboard([[Markup.button.callback('🔔 Unsnooze', 'snooze:off'), Markup.button.callback('🏠 Menu', 'nav:main')]]) });
    }
  } catch (e) {
    try { await ctx.reply('❌ Failed to snooze.', { ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Menu', 'nav:main')]]) }); } catch (e2) {}
  }
});

bot.command('cipher', async (ctx) => {
  try {
    const loadingMsg = await ctx.reply('🔄 Loading CIPHER data...');
    
    // Fetch all data in parallel
    const [overview, supplyData] = await Promise.all([
      getTokenOverview(MINTS.CIPHER),
      fetchCipherSupplyData(),
    ]);
    
    const price = overview?.price || getPrice(MINTS.CIPHER);
    
    let msg = `🔷 *CIPHER Token*\n\n\`${MINTS.CIPHER}\`\n`;
    
    // Price & Market Data
    if (overview) {
      const priceChange = overview.priceChange24h || 0;
      const changeIcon = priceChange >= 0 ? '📈' : '📉';
      
      msg += `
💰 *Price:* ${price ? fmtPrice(price) : 'N/A'} ${changeIcon} ${priceChange >= 0 ? '+' : ''}${priceChange.toFixed(2)}%
🏦 *Market Cap:* ${overview.mc ? fmt(overview.mc) : 'N/A'}
💧 *Liquidity:* ${overview.liquidity ? fmt(overview.liquidity) : 'N/A'}
📊 *24h Volume:* ${overview.volume24h ? fmt(overview.volume24h) : 'N/A'}`;
    } else {
      msg += `\n💰 *Price:* ${price ? fmtPrice(price) : 'Loading...'}`;
    }
    
    // Supply Data
    if (supplyData) {
      msg += `

📦 *Supply:*
• Total: ${fmtSupply(supplyData.totalSupply)}
• Locked (Vesting): ${fmtSupply(supplyData.lockedVesting)} (${supplyData.lockedPercent.toFixed(2)}%)
• Circulating: ${fmtSupply(supplyData.circulatingSupply)} (${supplyData.circulatingPercent.toFixed(2)}%)
• Staked: ${fmtSupply(supplyData.stakedSupply)} (${supplyData.stakedPercent.toFixed(2)}%)`;
    }
    
    // Activity Data
    if (overview) {
      msg += `

📈 *Activity:*
• Holders: ${overview.holders ? overview.holders.toLocaleString() : 'N/A'}
• 24h Trades: ${overview.trades24h || 'N/A'} (🟢 ${overview.buy24h || 0} / 🔴 ${overview.sell24h || 0})
• Unique Wallets: ${overview.uniqueWallets24h || 'N/A'}`;
    }
    
    try { await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id); } catch (e) {}
    
    await ctx.reply(msg, { 
      parse_mode: 'Markdown', 
      ...Markup.inlineKeyboard([
        [
          Markup.button.url('📊 Chart', 'https://dexscreener.com/solana/' + MINTS.CIPHER),
          Markup.button.url('🔍 Solscan', 'https://solscan.io/token/' + MINTS.CIPHER),
        ],
        [
          Markup.button.url('🔒 Staking', 'https://app.cipherlabsx.com/staking'),
          Markup.button.url('📋 Vesting', 'https://app.streamflow.finance/token-dashboard/solana/mainnet/' + MINTS.CIPHER),
        ],
        [Markup.button.callback('🔷 CIPHER Settings', 'nav:cipher')],
      ])
    });
  } catch (e) {
    log.error('CIPHER command error:', e);
    await ctx.reply('❌ Failed to load CIPHER data.', { ...Markup.inlineKeyboard([[Markup.button.callback('🔷 CIPHER Settings', 'nav:cipher'), Markup.button.callback('🏠 Menu', 'nav:main')]]) });
  }
});

bot.command('price', async (ctx) => {
  try {
    const solPrice = getPrice(MINTS.SOL);
    const cipherPrice = getPrice(MINTS.CIPHER);
    const cipherOverview = await getTokenOverview(MINTS.CIPHER);
    
    const cipherChange = cipherOverview?.priceChange24h || 0;
    const cipherChangeIcon = cipherChange >= 0 ? '📈' : '📉';
    
    const msg = `💰 *Current Prices*

◎ *SOL:* $${solPrice ? solPrice.toFixed(2) : 'N/A'}
🔷 *CIPHER:* ${cipherPrice ? fmtPrice(cipherPrice) : 'N/A'} ${cipherChangeIcon} ${cipherChange >= 0 ? '+' : ''}${cipherChange.toFixed(2)}%

_Source: ${priceApiStatus === 'jupiter' ? 'Jupiter' : priceApiStatus === 'dexscreener' ? 'DexScreener' : priceApiStatus === 'birdeye' ? 'Birdeye' : priceApiStatus === 'coingecko' ? 'CoinGecko' : priceApiStatus}_`;

    await ctx.reply(msg, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Refresh', 'cmd:refreshprice')],
      ])
    });
  } catch (e) {
    await ctx.reply('❌ Failed to load prices.', { ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Menu', 'nav:main')]]) });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// NEW QUICK ACCESS COMMANDS
// ═══════════════════════════════════════════════════════════════════════════════

bot.command('portfolio', async (ctx) => {
  try {
    const user = getUser(ctx.chat.id) || createUser(ctx.chat.id);
    await ctx.reply(text.portfolio(user), { parse_mode: 'Markdown', ...menu.portfolio(user) });
  } catch (e) {
    await ctx.reply('❌ Failed to load portfolio.', { ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Menu', 'nav:main')]]) });
  }
});

bot.command('help', async (ctx) => {
  try {
    await ctx.reply(text.help(), {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🌐 Pools', 'nav:pools'), Markup.button.callback('🔥 Trending', 'nav:trending')],
        [Markup.button.callback('📈 Portfolio', 'nav:portfolio'), Markup.button.callback('⚙️ Settings', 'nav:settings')],
        [Markup.button.callback('🏠 Menu', 'nav:main')],
      ])
    });
  } catch (e) {
    try { await ctx.reply('❌ Failed to load help. Try /start'); } catch (e2) {}
  }
});

bot.command('lp', async (ctx) => {
  try {
    const user = getUser(ctx.chat.id);
    const walletList = user?.portfolioWallets || [];
    const hasWallets = walletList.length > 0 || !!user?.myWallet;
    
    if (!hasWallets) {
      await ctx.reply('💧 Add a wallet first to view LP positions.', {
        ...Markup.inlineKeyboard([[Markup.button.callback('➕ Add Wallet', 'portfolio:addwallet')]])
      });
      return;
    }

    const positions = user.portfolio?.lpPositions || [];
    await ctx.reply(text.portfolioLp(positions), { parse_mode: 'Markdown', ...menu.portfolioLp(positions) });
  } catch (e) {
    await ctx.reply('❌ Failed to load LP positions.', { ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Menu', 'nav:main')]]) });
  }
});

bot.command('pnl', async (ctx) => {
  try {
    const user = getUser(ctx.chat.id);
    const walletList = user?.portfolioWallets || [];
    const hasWallets = walletList.length > 0 || !!user?.myWallet;
    
    if (!hasWallets) {
      await ctx.reply('📊 Add a wallet first to view PnL.', {
        ...Markup.inlineKeyboard([[Markup.button.callback('➕ Add Wallet', 'portfolio:addwallet')]])
      });
      return;
    }
    
    const p = user.portfolio || {};
    const walletCount = p.walletCount || walletList.length || 1;
    const realizedPnl = p.realizedPnl || 0;
    const unrealizedPnl = p.unrealizedPnl || 0;
    const totalPnl = realizedPnl + unrealizedPnl;
    const pnlPercent = p.totalVolume > 0 ? ((realizedPnl / p.totalVolume) * 100).toFixed(1) : '0.0';
    
    const pnlIcon = totalPnl >= 0 ? '🟢' : '🔴';
    const realIcon = realizedPnl >= 0 ? '🟢' : '🔴';
    const unrealIcon = unrealizedPnl >= 0 ? '📈' : '📉';
    
    const msg = `${pnlIcon} *PnL Summary*

*${walletCount} wallet${walletCount !== 1 ? 's' : ''} tracked*

${realIcon} *Realized:* ${realizedPnl >= 0 ? '+' : '-'}${fmt(Math.abs(realizedPnl))} (${pnlPercent}%)
${unrealIcon} *Unrealized:* ${unrealizedPnl >= 0 ? '+' : '-'}${fmt(Math.abs(unrealizedPnl))}

💎 *Total:* ${totalPnl >= 0 ? '+' : '-'}${fmt(Math.abs(totalPnl))}

📈 Volume: ${fmt(p.totalVolume || 0)}
🔄 Trades: ${p.tradeCount || 0} (🟢 ${p.buyCount || 0} / 🔴 ${p.sellCount || 0})

_Last sync: ${p.lastSync ? new Date(p.lastSync).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }) : 'Never'} UTC_`;

    await ctx.reply(msg, { 
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Refresh', 'portfolio:sync'), Markup.button.callback('📊 Full Stats', 'portfolio:stats')],
        [Markup.button.callback('📈 Portfolio', 'nav:portfolio'), Markup.button.callback('🏠 Menu', 'nav:main')],
      ])
    });
  } catch (e) {
    await ctx.reply('❌ Failed to load PnL.', { ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Menu', 'nav:main')]]) });
  }
});

bot.command('refresh', async (ctx) => {
  try {
    const user = getUser(ctx.chat.id);
    const walletList = user?.portfolioWallets || [];
    const hasWallets = walletList.length > 0 || !!user?.myWallet;
    
    if (!hasWallets) {
      await ctx.reply('👛 Add a wallet first.', {
        ...Markup.inlineKeyboard([[Markup.button.callback('➕ Add Wallet', 'portfolio:addwallet')]])
      });
      return;
    }
    
    const loadingMsg = await ctx.reply('🔄 Syncing portfolio...');
    
    await syncPortfolio(ctx.chat.id);
    
    try { await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id); } catch (e) {}
    
    const updatedUser = getUser(ctx.chat.id);
    await ctx.reply('✅ Portfolio synced!\n\n' + text.portfolio(updatedUser), { 
      parse_mode: 'Markdown', 
      ...menu.portfolio(updatedUser) 
    });
  } catch (e) {
    await ctx.reply('❌ Sync failed. Try again.', { ...Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'portfolio:sync'), Markup.button.callback('🏠 Menu', 'nav:main')]]) });
  }
});

bot.command('wallets', async (ctx) => {
  try {
    const user = getUser(ctx.chat.id) || createUser(ctx.chat.id);
    await ctx.reply(text.wallets(user), { parse_mode: 'Markdown', ...menu.wallets(user) });
  } catch (e) {
    await ctx.reply('❌ Failed to load wallets.', { ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Menu', 'nav:main')]]) });
  }
});

// Pool Explorer commands
bot.command('pools', async (ctx) => {
  try {
    const user = getUser(ctx.chat.id) || createUser(ctx.chat.id);
    await ctx.reply(text.pools('volume'), { parse_mode: 'Markdown', ...menu.pools(user, 0, 'volume') });
  } catch (e) {
    await ctx.reply('❌ Failed to load pools.', { ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Menu', 'nav:main')]]) });
  }
});

bot.command('trending', async (ctx) => {
  try {
    await ctx.reply(text.trending(), { parse_mode: 'Markdown', ...menu.trending() });
  } catch (e) {
    await ctx.reply('❌ Failed to load trending pools.', { ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Menu', 'nav:main')]]) });
  }
});

bot.command('newpools', async (ctx) => {
  try {
    const newPools = getNewPools(48); // Pools added in last 48 hours
    if (newPools.length === 0) {
      await ctx.reply('📭 *No new pools*\n\nNo new pools have been added in the last 48 hours.', { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🔄 Browse Pools', 'nav:pools'), Markup.button.callback('🏠 Menu', 'nav:main')]]) });
      return;
    }
    
    const btns = newPools.slice(0, 10).map(p => {
      const pairName = p.pairName || formatPair(p.baseMint || p.base, p.quoteMint || p.quote);
      const age = getPoolAge(p);
      const icon = p.isCipher ? '🔷' : '🌐';
      return [Markup.button.callback(`${icon} ${pairName} • ${age}`, `pool:view:${p.id}`)];
    });
    btns.push([Markup.button.callback('📋 All Pools', 'nav:pools'), Markup.button.callback('🏠 Menu', 'nav:main')]);
    
    await ctx.reply(`🆕 *New Pools*\n\n${newPools.length} pool${newPools.length !== 1 ? 's' : ''} added in the last 48h:`, { 
      parse_mode: 'Markdown', 
      ...Markup.inlineKeyboard(btns) 
    });
  } catch (e) {
    await ctx.reply('❌ Failed to load new pools.', { ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Menu', 'nav:main')]]) });
  }
});

bot.command('settings', async (ctx) => {
  try {
    const user = getUser(ctx.chat.id) || createUser(ctx.chat.id);
    await ctx.reply(text.settings(user), { parse_mode: 'Markdown', ...menu.settings(user) });
  } catch (e) {
    await ctx.reply('❌ Failed to load settings.', { ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Menu', 'nav:main')]]) });
  }
});

bot.command('stats', async (ctx) => {
  try {
    const user = getUser(ctx.chat.id);
    if (!user) {
      await ctx.reply('👋 Get started first to track your stats!', {
        ...Markup.inlineKeyboard([[Markup.button.callback('🚀 Get Started', 'setup:start')]])
      });
      return;
    }
    
    const s = user.stats || {};
    const t = user.todayStats || {};
    
    // Check if day changed
    const now = new Date();
    const lastReset = new Date(t.lastReset || 0);
    if (now.toDateString() !== lastReset.toDateString()) {
      user.todayStats = { trades: 0, lp: 0, wallet: 0, events: 0, lastReset: Date.now() };
      saveUsersDebounced();  // Debounced for performance
    }

    const msg = `📊 *Your Statistics*

*Today:*
├ Trades: ${t.trades || 0}
├ LP Events: ${t.lp || 0}
├ Wallet Alerts: ${t.wallet || 0}
└ Event Alerts: ${t.events || 0}

*All Time:*
├ 🔷 CIPHER Buys: ${s.cipherBuys || 0}
├ 🔷 CIPHER Sells: ${s.cipherSells || 0}
├ 🔷 CIPHER LP: ${s.cipherLp || 0}
├ 🌐 Other Trades: ${s.otherTrades || 0}
├ 🌐 Other LP: ${s.otherLp || 0}
├ 🐋 Wallet Alerts: ${s.walletAlerts || 0}
├ 🔔 Events: ${s.events || 0}
└ 💰 Volume Tracked: ${fmt(s.volume || 0)}

_Member since: ${new Date(user.createdAt || Date.now()).toLocaleDateString('en-US', { timeZone: 'UTC' })}_`;

    await ctx.reply(msg, { 
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🗑️ Reset Stats', 'confirm:resetstats')],
        [Markup.button.callback('🏠 Menu', 'nav:main')],
      ])
    });
  } catch (e) {
    await ctx.reply('❌ Failed to load stats.', { ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Menu', 'nav:main')]]) });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// LEADERBOARD COMMAND
// ═══════════════════════════════════════════════════════════════════════════════
bot.command('leaderboard', async (ctx) => {
  if (!checkCooldown(ctx.chat.id)) {
    return await ctx.reply('⏳ Too fast! Try again in a second.');
  }
  
  try {
    const args = ctx.message.text.split(' ').slice(1);
    const mintOrSymbol = args[0];
    
    // Default to CIPHER if no argument
    let mint = MINTS.CIPHER;
    let symbol = 'CIPHER';
    
    if (mintOrSymbol) {
      // Check if it's a known symbol
      const upperSymbol = mintOrSymbol.toUpperCase();
      if (upperSymbol === 'SOL') {
        mint = MINTS.SOL;
        symbol = 'SOL';
      } else if (upperSymbol === 'CIPHER') {
        mint = MINTS.CIPHER;
        symbol = 'CIPHER';
      } else if (isValidMint(mintOrSymbol)) {
        mint = mintOrSymbol;
        symbol = getSymbol(mint);
      } else {
        // Try to find by symbol
        const found = [...tokens.entries()].find(([_, t]) => 
          t.symbol?.toUpperCase() === upperSymbol
        );
        if (found) {
          mint = found[0];
          symbol = found[1].symbol;
        } else {
          return await ctx.reply(`❌ Unknown token: ${escMd(mintOrSymbol)}\n\nUsage: \`/leaderboard [token]\`\nExamples:\n• /leaderboard\n• /leaderboard CIPHER\n• /leaderboard SOL`, { parse_mode: 'Markdown' });
        }
      }
    }
    
    const loadingMsg = await ctx.reply('🔄 *Loading leaderboard...*', { parse_mode: 'Markdown' });

    const data = await fetchPnLLeaderboard(mint, 10);
    const message = formatLeaderboardMessage(data);

    try { await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id); } catch (e) {}

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Refresh', `leaderboard:${mint}`)],
        [Markup.button.callback('📊 View Chart', `chart:${mint}`)],
        [Markup.button.callback('🏠 Menu', 'nav:main')],
      ])
    });
    
  } catch (e) {
    log.error('Leaderboard command error:', e);
    await ctx.reply('❌ Failed to load leaderboard.', { ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Menu', 'nav:main')]]) });
  }
});

// Leaderboard refresh action
bot.action(/^leaderboard:(.+)$/, async (ctx) => {
  await safeAnswer(ctx, '🔄 Refreshing...');
  
  try {
    const mint = ctx.match[1];
    const data = await fetchPnLLeaderboard(mint, 10);
    const message = formatLeaderboardMessage(data);
    
    await safeEdit(ctx, message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Refresh', `leaderboard:${mint}`)],
        [Markup.button.callback('📊 View Chart', `chart:${mint}`)],
        [Markup.button.callback('🏠 Menu', 'nav:main')],
      ])
    });
  } catch (e) {
    await ctx.reply('❌ Failed to refresh leaderboard.');
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// CHART COMMAND
// ═══════════════════════════════════════════════════════════════════════════════
bot.command('chart', async (ctx) => {
  if (!checkCooldown(ctx.chat.id)) {
    return await ctx.reply('⏳ Too fast! Try again in a second.');
  }
  
  try {
    const args = ctx.message.text.split(' ').slice(1);
    const poolIdOrSymbol = args[0];
    const timeframe = args[1] || '1h';
    
    // Validate timeframe
    const validTimeframes = ['15m', '1h', '4h', '1d'];
    const tf = validTimeframes.includes(timeframe) ? timeframe : '1h';
    
    // Find pool
    let pool = null;
    let symbol = 'CIPHER';
    
    if (!poolIdOrSymbol) {
      // Default to first CIPHER pool
      pool = cipherPools[0];
      if (pool) symbol = pool.pairName;
    } else if (poolMap.has(poolIdOrSymbol)) {
      pool = poolMap.get(poolIdOrSymbol);
      symbol = pool.pairName;
    } else {
      // Search by name
      const search = poolIdOrSymbol.toUpperCase();
      pool = pools.find(p => 
        p.pairName?.toUpperCase().includes(search) ||
        getSymbol(p.baseMint)?.toUpperCase() === search
      );
      if (pool) symbol = pool.pairName;
    }
    
    if (!pool) {
      return await ctx.reply(`❌ Pool not found: ${poolIdOrSymbol}\n\nUsage: \`/chart [pool] [timeframe]\`\nTimeframes: 15m, 1h, 4h, 1d\n\nExamples:\n• /chart\n• /chart CIPHER 1h`, { parse_mode: 'Markdown' });
    }
    
    const chartLoadingMsg = await ctx.reply('📊 *Generating chart...*', { parse_mode: 'Markdown' });

    // Fetch candle data
    const candles = await fetchOHLCVData(pool.id, tf, 48);
    
    const baseMint = pool.baseMint || pool.base;

    if (candles.length < 2) {
      try { await ctx.telegram.deleteMessage(ctx.chat.id, chartLoadingMsg.message_id); } catch (e) {}
      return await ctx.reply(`❌ Not enough data for ${escMd(symbol)} chart.`, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.url('📊 View on DexScreener', `https://dexscreener.com/solana/${baseMint}`)],
          [Markup.button.callback('🏠 Menu', 'nav:main')]
        ])
      });
    }

    // Generate chart image
    const chartBuffer = await generatePriceChart(candles, symbol, tf);

    if (!chartBuffer) {
      try { await ctx.telegram.deleteMessage(ctx.chat.id, chartLoadingMsg.message_id); } catch (e) {}
      return await ctx.reply('❌ Failed to generate chart.', {
        ...Markup.inlineKeyboard([
          [Markup.button.url('📊 View on DexScreener', `https://dexscreener.com/solana/${baseMint}`)],
          [Markup.button.callback('🏠 Menu', 'nav:main')]
        ])
      });
    }
    
    // Calculate stats
    const firstPrice = candles[0].close;
    const lastPrice = candles[candles.length - 1].close;
    const change = firstPrice > 0 ? ((lastPrice - firstPrice) / firstPrice) * 100 : 0;
    const high = Math.max(...candles.map(c => c.high));
    const low = Math.min(...candles.map(c => c.low));
    const volume = candles.reduce((sum, c) => sum + c.volume, 0);
    
    const caption = `📊 *${escMd(symbol)}* • ${tf.toUpperCase()}

💰 *Price:* ${fmtPrice(lastPrice)}
${change >= 0 ? '📈' : '📉'} *Change:* ${change >= 0 ? '+' : ''}${change.toFixed(2)}%

📈 *High:* ${fmtPrice(high)}
📉 *Low:* ${fmtPrice(low)}
📊 *Volume:* ${fmt(volume)}

_${candles.length} candles • Updated ${fmtTime()} UTC_`;
    
    try { await ctx.telegram.deleteMessage(ctx.chat.id, chartLoadingMsg.message_id); } catch (e) {}

    await ctx.replyWithPhoto(
      { source: chartBuffer },
      {
        caption,
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('15m', `chart:${pool.id}:15m`),
            Markup.button.callback('1H', `chart:${pool.id}:1h`),
            Markup.button.callback('4H', `chart:${pool.id}:4h`),
            Markup.button.callback('1D', `chart:${pool.id}:1d`),
          ],
          [Markup.button.callback('🔄 Refresh', `chart:${pool.id}:${tf}`)],
          [Markup.button.callback('🏆 Leaderboard', `leaderboard:${baseMint}`)],
          [Markup.button.url('📊 DexScreener', `https://dexscreener.com/solana/${baseMint}`)],
        ])
      }
    );

  } catch (e) {
    log.error('Chart command error:', e);
    const fallbackBtns = pool
      ? [[Markup.button.url('📊 View on DexScreener', `https://dexscreener.com/solana/${pool.baseMint || pool.base}`)], [Markup.button.callback('🏠 Menu', 'nav:main')]]
      : [[Markup.button.callback('🏠 Menu', 'nav:main')]];
    await ctx.reply('❌ Failed to generate chart.', { ...Markup.inlineKeyboard(fallbackBtns) });
  }
});

// Chart action (timeframe switching)
bot.action(/^chart:(.+):(15m|1h|4h|1d)$/, async (ctx) => {
  await safeAnswer(ctx, '📊 Loading...');
  
  try {
    const poolId = ctx.match[1];
    const tf = ctx.match[2];
    
    const pool = poolMap.get(poolId);
    if (!pool) {
      return await ctx.reply('❌ Pool not found.');
    }
    
    const symbol = pool.pairName;
    const baseMint = pool.baseMint || pool.base;
    const candles = await fetchOHLCVData(poolId, tf, 48);

    if (candles.length < 2) {
      return await ctx.reply(`❌ Not enough data for ${tf} chart.`, {
        ...Markup.inlineKeyboard([
          [Markup.button.url('📊 View on DexScreener', `https://dexscreener.com/solana/${baseMint}`)],
          [Markup.button.callback('🏠 Menu', 'nav:main')]
        ])
      });
    }

    const chartBuffer = await generatePriceChart(candles, symbol, tf);

    if (!chartBuffer) {
      return await ctx.reply('❌ Failed to generate chart.', {
        ...Markup.inlineKeyboard([
          [Markup.button.url('📊 View on DexScreener', `https://dexscreener.com/solana/${baseMint}`)],
          [Markup.button.callback('🏠 Menu', 'nav:main')]
        ])
      });
    }

    const firstPrice = candles[0].close;
    const lastPrice = candles[candles.length - 1].close;
    const change = firstPrice > 0 ? ((lastPrice - firstPrice) / firstPrice) * 100 : 0;
    const high = Math.max(...candles.map(c => c.high));
    const low = Math.min(...candles.map(c => c.low));

    const caption = `📊 *${escMd(symbol)}* • ${tf.toUpperCase()}

💰 *Price:* ${fmtPrice(lastPrice)}
${change >= 0 ? '📈' : '📉'} *Change:* ${change >= 0 ? '+' : ''}${change.toFixed(2)}%
📈 *High:* ${fmtPrice(high)} • 📉 *Low:* ${fmtPrice(low)}

_Updated ${fmtTime()} UTC_`;

    // Send new photo (can't edit photo)
    await ctx.replyWithPhoto(
      { source: chartBuffer },
      {
        caption,
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('15m', `chart:${poolId}:15m`),
            Markup.button.callback('1H', `chart:${poolId}:1h`),
            Markup.button.callback('4H', `chart:${poolId}:4h`),
            Markup.button.callback('1D', `chart:${poolId}:1d`),
          ],
          [Markup.button.callback('🔄 Refresh', `chart:${poolId}:${tf}`)],
          [Markup.button.url('📊 DexScreener', `https://dexscreener.com/solana/${baseMint}`)],
        ])
      }
    );
  } catch (e) {
    log.error('Chart action error:', e);
    await ctx.reply('❌ Failed to update chart.');
  }
});

// Chart action (from token mint)
bot.action(/^chart:([1-9A-HJ-NP-Za-km-z]{32,44})$/, async (ctx) => {
  await safeAnswer(ctx, '📊 Loading...');
  
  try {
    const mint = ctx.match[1];
    
    // Find a pool with this token
    const pool = pools.find(p => p.baseMint === mint || p.quoteMint === mint);
    
    const dexUrl = `https://dexscreener.com/solana/${mint}`;

    if (!pool) {
      return await ctx.reply('❌ No pool found for this token.', {
        ...Markup.inlineKeyboard([
          [Markup.button.url('📊 View on DexScreener', dexUrl)],
          [Markup.button.callback('🏠 Menu', 'nav:main')]
        ])
      });
    }

    const symbol = pool.pairName;
    const tf = '1h';
    const candles = await fetchOHLCVData(pool.id, tf, 48);

    if (candles.length < 2) {
      return await ctx.reply('❌ Not enough chart data available.', {
        ...Markup.inlineKeyboard([
          [Markup.button.url('📊 View on DexScreener', dexUrl)],
          [Markup.button.callback('🏠 Menu', 'nav:main')]
        ])
      });
    }

    const chartBuffer = await generatePriceChart(candles, symbol, tf);

    if (!chartBuffer) {
      return await ctx.reply('❌ Failed to generate chart.', {
        ...Markup.inlineKeyboard([
          [Markup.button.url('📊 View on DexScreener', dexUrl)],
          [Markup.button.callback('🏠 Menu', 'nav:main')]
        ])
      });
    }

    const lastPrice = candles[candles.length - 1].close;

    await ctx.replyWithPhoto(
      { source: chartBuffer },
      {
        caption: `📊 *${escMd(symbol)}* • 1H\n\n💰 Price: ${fmtPrice(lastPrice)}`,
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('15m', `chart:${pool.id}:15m`),
            Markup.button.callback('1H', `chart:${pool.id}:1h`),
            Markup.button.callback('4H', `chart:${pool.id}:4h`),
            Markup.button.callback('1D', `chart:${pool.id}:1d`),
          ],
          [Markup.button.url('📊 DexScreener', dexUrl)],
        ])
      }
    );
  } catch (e) {
    log.error('Chart mint action error:', e);
    await ctx.reply('❌ Failed to generate chart.');
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// LIQUIDITY HISTORY COMMAND
// ═══════════════════════════════════════════════════════════════════════════════
bot.command('liquidity', async (ctx) => {
  if (!checkCooldown(ctx.chat.id)) {
    return await ctx.reply('⏳ Too fast! Try again in a second.');
  }
  
  try {
    const args = ctx.message.text.split(' ').slice(1);
    const poolIdOrSymbol = args[0];
    
    let pool = null;
    
    if (!poolIdOrSymbol) {
      // Show CIPHER pools liquidity
      pool = cipherPools[0];
    } else if (poolMap.has(poolIdOrSymbol)) {
      pool = poolMap.get(poolIdOrSymbol);
    } else {
      const search = poolIdOrSymbol.toUpperCase();
      pool = pools.find(p => 
        p.pairName?.toUpperCase().includes(search)
      );
    }
    
    if (!pool) {
      return await ctx.reply(`❌ Pool not found.\n\nUsage: \`/liquidity [pool]\``, { parse_mode: 'Markdown' });
    }
    
    const message = formatLiquidityHistory(pool.id);
    
    await ctx.reply(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Refresh', `liqhistory:${pool.id}`)],
        [Markup.button.callback('📊 Chart', `chart:${pool.id}:1h`)],
        [Markup.button.callback('🏠 Menu', 'nav:main')],
      ])
    });
    
  } catch (e) {
    log.error('Liquidity command error:', e);
    await ctx.reply('❌ Failed to load liquidity history.', { ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Menu', 'nav:main')]]) });
  }
});

bot.action(/^liqhistory:(.+)$/, async (ctx) => {
  await safeAnswer(ctx, '🔄 Refreshing...');
  
  const poolId = ctx.match[1];
  const message = formatLiquidityHistory(poolId);
  
  await safeEdit(ctx, message, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('🔄 Refresh', `liqhistory:${poolId}`)],
      [Markup.button.callback('📊 Chart', `chart:${poolId}:1h`)],
      [Markup.button.callback('🏠 Menu', 'nav:main')],
    ])
  });
});

// Shortcut actions for CIPHER
bot.action('chart:cipher', async (ctx) => {
  await safeAnswer(ctx, '📊 Loading CIPHER chart...');

  const dexUrl = `https://dexscreener.com/solana/${MINTS.CIPHER}`;

  try {
    const pool = cipherPools[0];
    if (!pool) {
      return await ctx.reply('❌ No CIPHER pools found.', {
        ...Markup.inlineKeyboard([
          [Markup.button.url('📊 View on DexScreener', dexUrl)],
          [Markup.button.callback('🏠 Menu', 'nav:main')]
        ])
      });
    }

    const tf = '1h';
    const candles = await fetchOHLCVData(pool.id, tf, 48);

    if (candles.length < 2) {
      return await ctx.reply('❌ Not enough chart data available.', {
        ...Markup.inlineKeyboard([
          [Markup.button.url('📊 View on DexScreener', dexUrl)],
          [Markup.button.callback('🏠 Menu', 'nav:main')]
        ])
      });
    }

    const chartBuffer = await generatePriceChart(candles, pool.pairName, tf);

    if (!chartBuffer) {
      return await ctx.reply('❌ Failed to generate chart.', {
        ...Markup.inlineKeyboard([
          [Markup.button.url('📊 View on DexScreener', dexUrl)],
          [Markup.button.callback('🏠 Menu', 'nav:main')]
        ])
      });
    }

    const firstPrice = candles[0].close;
    const lastPrice = candles[candles.length - 1].close;
    const change = firstPrice > 0 ? ((lastPrice - firstPrice) / firstPrice) * 100 : 0;

    await ctx.replyWithPhoto(
      { source: chartBuffer },
      {
        caption: `📊 *${escMd(pool.pairName)}* • 1H\n\n💰 *Price:* ${fmtPrice(lastPrice)}\n${change >= 0 ? '📈' : '📉'} *Change:* ${change >= 0 ? '+' : ''}${change.toFixed(2)}%`,
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('15m', `chart:${pool.id}:15m`),
            Markup.button.callback('1H', `chart:${pool.id}:1h`),
            Markup.button.callback('4H', `chart:${pool.id}:4h`),
            Markup.button.callback('1D', `chart:${pool.id}:1d`),
          ],
          [Markup.button.callback('🏆 Leaderboard', `leaderboard:${MINTS.CIPHER}`)],
          [Markup.button.url('📊 DexScreener', dexUrl)],
        ])
      }
    );
  } catch (e) {
    log.error('Chart cipher shortcut error:', e);
    await ctx.reply('❌ Failed to generate chart.', {
      ...Markup.inlineKeyboard([
        [Markup.button.url('📊 View on DexScreener', dexUrl)],
        [Markup.button.callback('🏠 Menu', 'nav:main')]
      ])
    });
  }
});

bot.action('leaderboard:cipher', async (ctx) => {
  await safeAnswer(ctx, '🏆 Loading leaderboard...');
  
  try {
    const data = await fetchPnLLeaderboard(MINTS.CIPHER, 10);
    const message = formatLeaderboardMessage(data);
    
    await ctx.reply(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Refresh', `leaderboard:${MINTS.CIPHER}`)],
        [Markup.button.callback('📊 View Chart', 'chart:cipher')],
        [Markup.button.callback('🏠 Menu', 'nav:main')],
      ])
    });
  } catch (e) {
    log.error('Leaderboard cipher shortcut error:', e);
    await ctx.reply('❌ Failed to load leaderboard.');
  }
});

bot.action('cmd:refreshprice', async (ctx) => {
  await safeAnswer(ctx, '🔄 Refreshing prices...');
  await fetchPrices();
  
  const solPrice = getPrice(MINTS.SOL);
  const cipherPrice = getPrice(MINTS.CIPHER);
  const cipherOverview = await getTokenOverview(MINTS.CIPHER);
  
  const cipherChange = cipherOverview?.priceChange24h || 0;
  const cipherChangeIcon = cipherChange >= 0 ? '📈' : '📉';
  
  const msg = `💰 *Current Prices*

◎ *SOL:* $${solPrice ? solPrice.toFixed(2) : 'N/A'}
🔷 *CIPHER:* ${cipherPrice ? fmtPrice(cipherPrice) : 'N/A'} ${cipherChangeIcon} ${cipherChange >= 0 ? '+' : ''}${cipherChange.toFixed(2)}%

_Source: ${priceApiStatus === 'jupiter' ? 'Jupiter' : priceApiStatus === 'dexscreener' ? 'DexScreener' : priceApiStatus === 'birdeye' ? 'Birdeye' : priceApiStatus === 'coingecko' ? 'CoinGecko' : priceApiStatus} • Updated just now_`;

  await safeEdit(ctx, msg, { 
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('🔄 Refresh', 'cmd:refreshprice')],
    ])
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// NAV ACTIONS
// ═══════════════════════════════════════════════════════════════════════════════
bot.action('nav:welcome', async (ctx) => {
  await safeAnswer(ctx);
  await safeEdit(ctx, text.welcome(), { parse_mode: 'Markdown', ...menu.welcome() });
});

bot.action('nav:main', async (ctx) => {
  await safeAnswer(ctx);
  const user = getUser(ctx.chat.id) || createUser(ctx.chat.id);
  await safeEdit(ctx, text.dashboard(user), { parse_mode: 'Markdown', ...menu.main(user) });
});

bot.action('nav:cipher', async (ctx) => {
  await safeAnswer(ctx);
  const user = getUser(ctx.chat.id);
  await safeEdit(ctx, text.cipher(user), { parse_mode: 'Markdown', ...menu.cipher(user) });
});

bot.action('nav:lp', async (ctx) => {
  await safeAnswer(ctx);
  const user = getUser(ctx.chat.id);
  await safeEdit(ctx, text.lp(user), { parse_mode: 'Markdown', ...menu.lp(user) });
});

bot.action('nav:wallets', async (ctx) => {
  await safeAnswer(ctx);
  const user = getUser(ctx.chat.id);
  await safeEdit(ctx, text.wallets(user), { parse_mode: 'Markdown', ...menu.wallets(user) });
});

bot.action('nav:allwallets', async (ctx) => {
  await safeAnswer(ctx);
  const user = getUser(ctx.chat.id);
  const wallets = user?.wallets || [];
  const btns = wallets.map(w => [
    Markup.button.callback(`👛 ${shortAddr(w)}`, `view:wallet:${w}`),
    Markup.button.callback('🗑️', `confirm:rmwhale:${w}`),
  ]);
  btns.push([Markup.button.callback('« Back', 'nav:wallets'), Markup.button.callback('🏠 Menu', 'nav:main')]);
  await safeEdit(ctx, `👛 *All Whale Wallets* (${wallets.length})`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(btns) });
});

bot.action('nav:watchlist', async (ctx) => {
  await safeAnswer(ctx);
  const user = getUser(ctx.chat.id);
  await safeEdit(ctx, text.watchlist(user), { parse_mode: 'Markdown', ...menu.watchlist(user) });
});

// Pool Explorer navigation
bot.action('nav:pools', async (ctx) => {
  await safeAnswer(ctx);
  const user = getUser(ctx.chat.id);
  await safeEdit(ctx, text.pools('volume'), { parse_mode: 'Markdown', ...menu.pools(user, 0, 'volume') });
});

bot.action('nav:trending', async (ctx) => {
  await safeAnswer(ctx);
  await safeEdit(ctx, text.trending(), { parse_mode: 'Markdown', ...menu.trending() });
});

bot.action('nav:newpools', async (ctx) => {
  await safeAnswer(ctx);
  const newPools = getNewPools(48);

  if (newPools.length === 0) {
    await safeEdit(ctx, `🆕 *New Pools*\n\nNo new pools added in the last 48 hours.`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('📋 All Pools', 'nav:pools'), Markup.button.callback('🏠 Menu', 'nav:main')]])
    });
    return;
  }

  const btns = newPools.slice(0, 10).map(p => {
    const pairName = p.pairName || formatPair(p.baseMint || p.base, p.quoteMint || p.quote);
    const age = getPoolAge(p);
    const icon = p.isCipher ? '🔷' : '🌐';
    return [Markup.button.callback(`${icon} ${pairName} • ${age}`, `pool:view:${p.id}`)];
  });
  btns.push([Markup.button.callback('📋 All Pools', 'nav:pools'), Markup.button.callback('🏠 Menu', 'nav:main')]);

  await safeEdit(ctx, `🆕 *New Pools*\n\n${newPools.length} pool${newPools.length !== 1 ? 's' : ''} added recently:`, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard(btns)
  });
});

bot.action('nav:othersettings', async (ctx) => {
  await safeAnswer(ctx);
  const user = getUser(ctx.chat.id);
  await safeEdit(ctx, text.otherPoolSettings(user), { parse_mode: 'Markdown', ...menu.otherPoolSettings(user) });
});

// Pool pagination
bot.action(/^pools:page:(\d+):(\w+)$/, async (ctx) => {
  await safeAnswer(ctx);
  const page = parseInt(ctx.match[1]);
  const sortBy = ctx.match[2];
  const user = getUser(ctx.chat.id);
  await safeEdit(ctx, text.pools(sortBy), { parse_mode: 'Markdown', ...menu.pools(user, page, sortBy) });
});

// Pool sorting
bot.action(/^pools:sort:(\w+)$/, async (ctx) => {
  const sortBy = ctx.match[1];
  const sortLabels = { volume: '24h Volume', tvl: 'TVL', trades: 'Trade Count' };
  const user = getUser(ctx.chat.id);
  await safeAnswer(ctx, `Sorted by ${sortLabels[sortBy] || sortBy}`);
  await safeEdit(ctx, text.pools(sortBy), { parse_mode: 'Markdown', ...menu.pools(user, 0, sortBy) });
});

// Pool search prompt
bot.action('pools:search', async (ctx) => {
  await safeAnswer(ctx);
  setUserState(ctx.chat.id, { awaiting: 'poolSearch' });
  await safeEdit(ctx, `🔍 *Search Pools*

Enter a token name or symbol (e.g. "SOL", "BONK"):`, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'nav:pools')]])
  });
});

// View single pool
bot.action(/^pool:view:(.+)$/, async (ctx) => {
  await safeAnswer(ctx);
  const poolId = ctx.match[1];
  const pool = getPoolById(poolId);
  const user = getUser(ctx.chat.id);

  if (!pool) {
    await safeEdit(ctx, `❌ *Pool Not Found*\n\nThis pool may have been removed.`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('📋 All Pools', 'nav:pools'), Markup.button.callback('🏠 Menu', 'nav:main')]])
    });
    return;
  }

  await safeEdit(ctx, text.poolView(pool), { parse_mode: 'Markdown', ...menu.poolView(pool, user) });
});

// Toggle pool watchlist
bot.action(/^pool:watch:(.+)$/, async (ctx) => {
  const poolId = ctx.match[1];
  const user = getUser(ctx.chat.id);
  if (!user) return;
  
  if (!user.watchlist) user.watchlist = [];
  
  const index = user.watchlist.indexOf(poolId);
  if (index > -1) {
    user.watchlist.splice(index, 1);
    await safeAnswer(ctx, '⭐ Removed from watchlist');
  } else {
    user.watchlist.push(poolId);
    await safeAnswer(ctx, '⭐ Added to watchlist!');
  }
  
  saveUsersDebounced();
  
  // Refresh the view
  const pool = getPoolById(poolId);
  if (pool) {
    await safeEdit(ctx, text.poolView(pool), { parse_mode: 'Markdown', ...menu.poolView(pool, user) });
  }
});

bot.action('nav:allwatchlist', async (ctx) => {
  await safeAnswer(ctx);
  const user = getUser(ctx.chat.id);
  const btns = [];

  (user?.trackedTokens || []).forEach(t => {
    btns.push([
      Markup.button.callback(`🪙 ${getSymbol(t)}`, `view:token:${t}`),
      Markup.button.callback('🗑️', `confirm:rmtoken:${t}`),
    ]);
  });

  (user?.watchlist || []).forEach(id => {
    const p = poolMap.get(id);
    btns.push([
      Markup.button.callback(`💎 ${p?.pairName || '???'}`, `view:pool:${id}`),
      Markup.button.callback('🗑️', `confirm:rmpool:${id}`),
    ]);
  });

  btns.push([Markup.button.callback('« Back', 'nav:watchlist'), Markup.button.callback('🏠 Menu', 'nav:main')]);
  const total = (user?.trackedTokens?.length || 0) + (user?.watchlist?.length || 0);
  await safeEdit(ctx, `⭐ *All Watchlist Items* (${total})`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(btns) });
});

bot.action('nav:snooze', async (ctx) => {
  await safeAnswer(ctx);
  const user = getUser(ctx.chat.id);
  await safeEdit(ctx, text.snooze(user), { parse_mode: 'Markdown', ...menu.snooze(user) });
});

bot.action('nav:quiet', async (ctx) => {
  await safeAnswer(ctx);
  const user = getUser(ctx.chat.id);
  await safeEdit(ctx, text.quiet(user), { parse_mode: 'Markdown', ...menu.quiet(user) });
});

bot.action('nav:history', async (ctx) => {
  await safeAnswer(ctx);
  const user = getUser(ctx.chat.id);
  await safeEdit(ctx, text.history(user), { parse_mode: 'Markdown', ...menu.history(user) });
});

bot.action('nav:settings', async (ctx) => {
  await safeAnswer(ctx);
  const user = getUser(ctx.chat.id) || createUser(ctx.chat.id);
  await safeEdit(ctx, text.settings(user), { parse_mode: 'Markdown', ...menu.settings(user) });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PORTFOLIO ACTIONS
// ═══════════════════════════════════════════════════════════════════════════════
bot.action('nav:portfolio', async (ctx) => {
  await safeAnswer(ctx);
  const user = getUser(ctx.chat.id) || createUser(ctx.chat.id);
  await safeEdit(ctx, text.portfolio(user), { parse_mode: 'Markdown', ...menu.portfolio(user) });
});

bot.action('portfolio:stats', async (ctx) => {
  await safeAnswer(ctx);
  const user = getUser(ctx.chat.id);
  const walletList = user?.portfolioWallets || [];
  const hasWallets = walletList.length > 0 || !!user?.myWallet;

  if (!hasWallets) {
    await safeEdit(ctx, `📊 *Portfolio Stats*\n\nAdd a wallet to view stats.`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('➕ Add Wallet', 'portfolio:addwallet')], [Markup.button.callback('🏠 Menu', 'nav:main')]])
    });
    return;
  }

  const firstWallet = user.myWallet || walletList[0];

  await safeEdit(ctx, text.portfolioStats(user), {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('🔄 Refresh', 'portfolio:sync')],
      [Markup.button.callback('👛 Manage Wallets', 'portfolio:wallets')],
      [
        Markup.button.url('🔍 Solscan', `https://solscan.io/account/${firstWallet}`),
        Markup.button.url('🦅 Birdeye', `https://birdeye.so/profile/${firstWallet}?chain=solana`),
      ],
      [Markup.button.callback('« Back', 'nav:portfolio'), Markup.button.callback('🏠 Menu', 'nav:main')],
    ])
  });
});

bot.action('portfolio:tokens', async (ctx) => {
  await safeAnswer(ctx);
  const user = getUser(ctx.chat.id);
  const walletList = user?.portfolioWallets || [];
  const hasWallets = walletList.length > 0 || !!user?.myWallet;

  if (!hasWallets) {
    await safeEdit(ctx, `🪙 *Token Holdings*\n\nAdd a wallet to view tokens.`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('➕ Add Wallet', 'portfolio:addwallet')], [Markup.button.callback('🏠 Menu', 'nav:main')]])
    });
    return;
  }

  const tokens = user.portfolio?.tokens || [];
  const totalValue = user.portfolio?.totalTokenValue || 0;
  await safeEdit(ctx, text.portfolioTokens(tokens, totalValue), {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('🔄 Refresh', 'portfolio:sync')],
      [Markup.button.callback('« Back', 'nav:portfolio'), Markup.button.callback('🏠 Menu', 'nav:main')],
    ])
  });
});

bot.action('portfolio:lp', async (ctx) => {
  await safeAnswer(ctx);
  const user = getUser(ctx.chat.id);
  const walletList = user?.portfolioWallets || [];
  const hasWallets = walletList.length > 0 || !!user?.myWallet;

  if (!hasWallets) {
    await safeEdit(ctx, `💧 *LP Positions*\n\nAdd a wallet to view LP positions.`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('➕ Add Wallet', 'portfolio:addwallet')], [Markup.button.callback('🏠 Menu', 'nav:main')]])
    });
    return;
  }

  const positions = user.portfolio?.lpPositions || [];
  await safeEdit(ctx, text.portfolioLp(positions), { parse_mode: 'Markdown', ...menu.portfolioLp(positions) });
});

bot.action('portfolio:trades', async (ctx) => {
  await safeAnswer(ctx);
  const user = getUser(ctx.chat.id);
  const walletList = user?.portfolioWallets || [];
  const hasWallets = walletList.length > 0 || !!user?.myWallet;

  if (!hasWallets) {
    await safeEdit(ctx, `📜 *Trade History*\n\nAdd a wallet to view trades.`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('➕ Add Wallet', 'portfolio:addwallet')], [Markup.button.callback('🏠 Menu', 'nav:main')]])
    });
    return;
  }

  const trades = user.portfolio?.trades || [];
  await safeEdit(ctx, text.portfolioTrades(trades), { parse_mode: 'Markdown', ...menu.portfolioTrades(trades, 0) });
});

bot.action(/^portfolio:lp:(\d+)$/, async (ctx) => {
  await safeAnswer(ctx);
  const page = parseInt(ctx.match[1]);
  const user = getUser(ctx.chat.id);
  const positions = user?.portfolio?.lpPositions || [];
  await safeEdit(ctx, text.portfolioLp(positions), { parse_mode: 'Markdown', ...menu.portfolioLp(positions, page) });
});

bot.action(/^portfolio:trades:(\d+)$/, async (ctx) => {
  await safeAnswer(ctx);
  const page = parseInt(ctx.match[1]);
  const user = getUser(ctx.chat.id);
  const trades = user?.portfolio?.trades || [];
  await safeEdit(ctx, text.portfolioTrades(trades), { parse_mode: 'Markdown', ...menu.portfolioTrades(trades, page) });
});

bot.action('portfolio:sync', async (ctx) => {
  const user = getUser(ctx.chat.id);
  const walletList = user?.portfolioWallets || [];
  const hasWallets = walletList.length > 0 || !!user?.myWallet;
  
  if (!hasWallets) {
    await safeAnswer(ctx, 'Add a wallet first');
    return;
  }
  
  await safeAnswer(ctx, '🔄 Syncing...');
  
  try {
    await syncPortfolio(ctx.chat.id);
    const updatedUser = getUser(ctx.chat.id);
    await safeEdit(ctx, text.portfolio(updatedUser), { parse_mode: 'Markdown', ...menu.portfolio(updatedUser) });
  } catch (e) {
    await safeEdit(ctx, text.portfolio(user) + '\n\n⚠️ _Sync failed, try again_', { parse_mode: 'Markdown', ...menu.portfolio(user) });
  }
});

// Portfolio wallet management
bot.action('portfolio:wallets', async (ctx) => {
  await safeAnswer(ctx);
  const user = getUser(ctx.chat.id);
  const walletList = user?.portfolioWallets || [];
  const walletCount = walletList.length || (user?.myWallet ? 1 : 0);

  await safeEdit(ctx, `👛 *Portfolio Wallets*\n\n${walletCount} wallet${walletCount !== 1 ? 's' : ''} tracked\n_Add up to 5 wallets_`, {
    parse_mode: 'Markdown',
    ...menu.portfolioWallets(user)
  });
});

bot.action('portfolio:addwallet', async (ctx) => {
  const user = getUser(ctx.chat.id);
  const walletList = user?.portfolioWallets || [];
  const walletCount = walletList.length || (user?.myWallet ? 1 : 0);

  if (walletCount >= 5) {
    await safeAnswer(ctx, '❌ Maximum 5 wallets allowed');
    return;
  }

  await safeAnswer(ctx);
  setUserState(ctx.chat.id, { awaiting: 'portfoliowallet' });
  await safeEdit(ctx, `➕ *Add Wallet*\n\nPaste a Solana wallet address:\n\n_${walletCount}/5 wallets used_`, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('« Cancel', 'portfolio:wallets')]])
  });
});

bot.action(/^portfolio:rmwallet:(.+)$/, async (ctx) => {
  await safeAnswer(ctx);
  const wallet = ctx.match[1];

  // Show confirmation dialog
  await safeEdit(ctx, `⚠️ *Remove Wallet?*\n\n\`${wallet}\`\n\nThis will remove all tracking data for this wallet.`, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('🗑️ Yes, Remove', `confirm:rmwallet:${wallet}`)],
      [Markup.button.callback('« Cancel', 'portfolio:wallets')],
    ])
  });
});

bot.action(/^confirm:rmwallet:(.+)$/, async (ctx) => {
  const wallet = ctx.match[1];
  const user = getUser(ctx.chat.id);
  
  if (!user) {
    await safeAnswer(ctx, 'Error');
    return;
  }
  
  // Remove from portfolioWallets array
  user.portfolioWallets = (user.portfolioWallets || []).filter(w => w !== wallet);
  
  // If it was myWallet, update that too
  if (user.myWallet === wallet) {
    user.myWallet = user.portfolioWallets[0] || null;
  }
  
  // Remove from walletData
  if (user.portfolio?.walletData) {
    delete user.portfolio.walletData[wallet];
  }
  
  saveUsersDebounced();  // Debounced for performance
  
  await safeAnswer(ctx, '✅ Wallet removed');
  
  // Re-sync if there are still wallets
  if (user.portfolioWallets.length > 0 || user.myWallet) {
    await syncPortfolio(ctx.chat.id);
  } else {
    user.portfolio = { trades: [], lpPositions: [], tokens: [], totalVolume: 0, realizedPnl: 0, unrealizedPnl: 0, totalValue: 0, tradeCount: 0, buyCount: 0, sellCount: 0, solBalance: 0, tokenCount: 0, walletData: {}, lastSync: 0 };
    saveUsersDebounced();  // Debounced for performance
  }
  
  const updatedUser = getUser(ctx.chat.id);
  await safeEdit(ctx, `👛 *Portfolio Wallets*\n\n${updatedUser.portfolioWallets?.length || 0} wallet${(updatedUser.portfolioWallets?.length || 0) !== 1 ? 's' : ''} tracked\n_Add up to 5 wallets_`, { 
    parse_mode: 'Markdown', 
    ...menu.portfolioWallets(updatedUser) 
  });
});

bot.action(/^portfolio:view:(.+)$/, async (ctx) => {
  await safeAnswer(ctx);
  const wallet = ctx.match[1];
  const user = getUser(ctx.chat.id);
  const walletData = user?.portfolio?.walletData?.[wallet] || {};

  const pnlIcon = (walletData.pnl || 0) >= 0 ? '🟢' : '🔴';
  const pnlSign = (walletData.pnl || 0) >= 0 ? '+' : '-';

  const msg = `👛 *Wallet Details*

\`${wallet}\`

💎 Value: ${fmt(walletData.value || 0)}
◎ SOL: ${(walletData.solBalance || 0).toFixed(4)}
🪙 Tokens: ${walletData.tokens || 0}

*Trading:*
📈 Volume: ${fmt(walletData.volume || 0)}
🔄 Trades: ${walletData.trades || 0} (🟢 ${walletData.buys || 0} / 🔴 ${walletData.sells || 0})
${pnlIcon} PnL: ${pnlSign}${fmt(Math.abs(walletData.pnl || 0))}`;

  await safeEdit(ctx, msg, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [
        Markup.button.url('🔍 Solscan', `https://solscan.io/account/${wallet}`),
        Markup.button.url('🦅 Birdeye', `https://birdeye.so/profile/${wallet}?chain=solana`),
      ],
      [Markup.button.callback('🗑️ Remove', `portfolio:rmwallet:${wallet}`)],
      [Markup.button.callback('« Back', 'portfolio:wallets'), Markup.button.callback('🏠 Menu', 'nav:main')],
    ])
  });
});


bot.action(/^view:lp:(.+)$/, async (ctx) => {
  await safeAnswer(ctx);
  const poolId = ctx.match[1];
  const user = getUser(ctx.chat.id);
  const position = user?.portfolio?.lpPositions?.find(p => p.poolId === poolId);

  if (!position) {
    await safeEdit(ctx, `❌ *Position Not Found*\n\nThis LP position may have been closed.`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('💧 LP Positions', 'portfolio:lp'), Markup.button.callback('🏠 Menu', 'nav:main')]])
    });
    return;
  }

  const pool = poolMap.get(poolId);
  const baseMint = pool?.baseMint || pool?.base || position.baseMint || poolId;
  
  const msg = `💧 *LP Position*

*Pool:* ${position.pool}
${position.isCipher ? '🔷 CIPHER Pool' : '🌐 Other Pool'}

*Your Position:*
📊 Shares: ${position.shares.toFixed(6)}
💰 Value: ${fmt(position.valueUsd)}`;

  await safeEdit(ctx, msg, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [
        Markup.button.url('🔍 Pool', `https://markets.cipherlabsx.com/pools/${poolId}`),
        Markup.button.url('📊 Chart', `https://dexscreener.com/solana/${baseMint}`),
      ],
      [Markup.button.callback('« Back', 'portfolio:lp'), Markup.button.callback('🏠 Menu', 'nav:main')],
    ])
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// INFO ACTIONS
// ═══════════════════════════════════════════════════════════════════════════════
bot.action('info:about', async (ctx) => {
  await safeAnswer(ctx);
  await safeEdit(ctx, text.about(), { parse_mode: 'Markdown', disable_web_page_preview: true, ...Markup.inlineKeyboard([
    [Markup.button.callback('🚀 Get Started', 'setup:start')],
    [Markup.button.callback('« Back', 'nav:welcome'), Markup.button.callback('🏠 Menu', 'nav:main')],
  ])});
});

bot.action('info:help', async (ctx) => {
  await safeAnswer(ctx);
  await safeEdit(ctx, text.help(), { parse_mode: 'Markdown', disable_web_page_preview: true, ...Markup.inlineKeyboard([
    [Markup.button.url('🌐 Orbit Markets', 'https://markets.cipherlabsx.com')],
    [Markup.button.url('🐦 Twitter', 'https://x.com/cipherlabsx')],
    [Markup.button.callback('« Back', 'nav:settings'), Markup.button.callback('🏠 Menu', 'nav:main')],
  ])});
});

// ═══════════════════════════════════════════════════════════════════════════════
// SETUP
// ═══════════════════════════════════════════════════════════════════════════════
bot.action('setup:start', async (ctx) => {
  await safeAnswer(ctx);
  await safeEdit(ctx, `🎯 *Quick Setup*

Choose a preset to get started:

🔷 *CIPHER Alerts* — Buy/sell trades & LP events for the CIPHER pool. Best for CIPHER holders.

💧 *LP Tracking* — Liquidity add/remove events across all pools. Best for LPs.

📊 *Everything* — All trade & LP alerts for every pool. Full coverage.

_You can customize thresholds anytime from Settings._`, { parse_mode: 'Markdown', ...menu.setup() });
});

bot.action(/^preset:(.+)$/, async (ctx) => {
  const mode = ctx.match[1];
  const presets = {
    cipher: { cipherBuys: true, cipherSells: true, cipherLpAdd: true, cipherLpRemove: true, cipherThreshold: 100, trackOtherPools: false },
    lp: { cipherBuys: false, cipherSells: false, cipherLpAdd: true, cipherLpRemove: true, trackOtherPools: true, otherLpAdd: true, otherLpRemove: true, otherLpThreshold: 250 },
    all: { cipherBuys: true, cipherSells: true, cipherLpAdd: true, cipherLpRemove: true, cipherThreshold: 100, trackOtherPools: true, otherLpAdd: true, otherLpRemove: true, otherLpThreshold: 500, otherBuys: true, otherSells: true, otherThreshold: 500 },
  };
  
  const modeNames = { cipher: 'CIPHER Alerts', lp: 'LP Tracking', all: 'Everything' };
  
  updateUser(ctx.chat.id, { ...presets[mode], onboarded: true });
  const user = getUser(ctx.chat.id);
  
  await safeEdit(ctx, `✅ *You're all set!*

Mode: *${modeNames[mode]}*
Alerts will appear in this chat.

*Next steps:*
• 👛 Add a wallet to track whale activity
• 📈 Link your wallet for portfolio & PnL
• 🌐 Browse pools to build your watchlist
• ⚙️ Adjust alert thresholds in Settings`, { parse_mode: 'Markdown', ...menu.main(user) });
  await safeAnswer(ctx, '✅ Setup complete!');
});

// ═══════════════════════════════════════════════════════════════════════════════
// TOGGLES
// ═══════════════════════════════════════════════════════════════════════════════
const ALLOWED_TOGGLES = new Set([
  'enabled', 'cipherBuys', 'cipherSells', 'cipherLpAdd', 'cipherLpRemove',
  'trackOtherPools', 'otherLpAdd', 'otherLpRemove', 'otherBuys', 'otherSells',
  'walletAlerts', 'dailyDigest', 'newPoolAlerts', 'lockAlerts', 'rewardAlerts',
  'closePoolAlerts', 'protocolFeeAlerts', 'adminAlerts',
]);

bot.action(/^tog:(.+)$/, async (ctx) => {
  const field = ctx.match[1];
  const user = getUser(ctx.chat.id);
  if (!user) { await safeAnswer(ctx); return; }

  if (!ALLOWED_TOGGLES.has(field)) {
    await safeAnswer(ctx, '❌ Invalid setting');
    return;
  }

  updateUser(ctx.chat.id, { [field]: !user[field] });
  const updated = getUser(ctx.chat.id);
  
  await safeAnswer(ctx, updated[field] ? '✅ Turned on' : '⬜ Turned off');
  
  if (field === 'walletAlerts') {
    refreshWalletSubscriptions();
    await safeEdit(ctx, text.wallets(updated), { parse_mode: 'Markdown', ...menu.wallets(updated) });
  } else if (field === 'trackOtherPools') {
    await safeEdit(ctx, text.otherPoolSettings(updated), { parse_mode: 'Markdown', ...menu.otherPoolSettings(updated) });
  } else if (field === 'enabled') {
    await safeEdit(ctx, text.settings(updated), { parse_mode: 'Markdown', ...menu.settings(updated) });
  } else if (field.startsWith('cipher')) {
    await safeEdit(ctx, text.cipher(updated), { parse_mode: 'Markdown', ...menu.cipher(updated) });
  } else if (field.startsWith('otherLp')) {
    await safeEdit(ctx, text.lp(updated), { parse_mode: 'Markdown', ...menu.lp(updated) });
  } else if (field === 'otherBuys' || field === 'otherSells') {
    await safeEdit(ctx, text.watchlist(updated), { parse_mode: 'Markdown', ...menu.watchlist(updated) });
  } else if (field === 'dailyDigest') {
    // Special message for daily digest toggle
    const digestMsg = updated.dailyDigest 
      ? '📬 Daily digest enabled! You\'ll receive a summary every day at 9:00 AM UTC.'
      : '📭 Daily digest disabled.';
    await safeAnswer(ctx, digestMsg);
    await safeEdit(ctx, text.settings(updated), { parse_mode: 'Markdown', ...menu.settings(updated) });
  } else if (['closePoolAlerts', 'protocolFeeAlerts', 'adminAlerts', 'newPoolAlerts', 'lockAlerts', 'rewardAlerts'].includes(field)) {
    const labels = { closePoolAlerts: 'Close Pool', protocolFeeAlerts: 'Protocol Fee', adminAlerts: 'Admin', newPoolAlerts: 'New Pool', lockAlerts: 'Lock/Unlock', rewardAlerts: 'Reward' };
    await safeAnswer(ctx, `${updated[field] ? '✅' : '❌'} ${labels[field]} alerts ${updated[field] ? 'enabled' : 'disabled'}`);
    await safeEdit(ctx, text.settings(updated), { parse_mode: 'Markdown', ...menu.settings(updated) });
  } else {
    await safeEdit(ctx, text.settings(updated), { parse_mode: 'Markdown', ...menu.settings(updated) });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// THRESHOLDS
// ═══════════════════════════════════════════════════════════════════════════════
bot.action(/^thresh:(.+)$/, async (ctx) => {
  await safeAnswer(ctx);
  const type = ctx.match[1];
  const user = getUser(ctx.chat.id);
  const currentMap = { cipher: user?.cipherThreshold, lp: user?.otherLpThreshold, other: user?.otherThreshold, watch: user?.otherThreshold };
  await safeEdit(ctx, `💰 *Set Minimum Amount*\n\nOnly get alerts above this value:`, { parse_mode: 'Markdown', ...menu.threshold(type, currentMap[type]) });
});

bot.action(/^setth:(.+):(\d+)$/, async (ctx) => {
  const type = ctx.match[1];
  const val = parseInt(ctx.match[2], 10);
  const fieldMap = { cipher: 'cipherThreshold', lp: 'otherLpThreshold', other: 'otherThreshold', watch: 'otherThreshold' };
  if (!fieldMap[type] || isNaN(val) || val < 0 || val > 1000000) return safeAnswer(ctx, '❌ Invalid threshold');
  updateUser(ctx.chat.id, { [fieldMap[type]]: val });
  
  const user = getUser(ctx.chat.id);
  await safeAnswer(ctx, `✅ Set to ${fmt(val)}`);
  
  if (type === 'cipher') await safeEdit(ctx, text.cipher(user), { parse_mode: 'Markdown', ...menu.cipher(user) });
  else if (type === 'lp') await safeEdit(ctx, text.lp(user), { parse_mode: 'Markdown', ...menu.lp(user) });
  else if (type === 'other') await safeEdit(ctx, text.otherPoolSettings(user), { parse_mode: 'Markdown', ...menu.otherPoolSettings(user) });
  else await safeEdit(ctx, text.watchlist(user), { parse_mode: 'Markdown', ...menu.watchlist(user) });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SNOOZE & QUIET
// ═══════════════════════════════════════════════════════════════════════════════
bot.action(/^snooze:(\d+)$/, async (ctx) => {
  const mins = parseInt(ctx.match[1], 10);
  if (isNaN(mins) || mins < 0 || mins > 1440) return safeAnswer(ctx, '❌ Invalid snooze duration');
  updateUser(ctx.chat.id, { snoozedUntil: Date.now() + mins * 60000 });
  const label = mins >= 60 ? `${mins/60} hour${mins > 60 ? 's' : ''}` : `${mins} minutes`;
  await safeAnswer(ctx, `🔕 Snoozed for ${label}`);
  const user = getUser(ctx.chat.id);
  await safeEdit(ctx, text.snooze(user), { parse_mode: 'Markdown', ...menu.snooze(user) });
});

bot.action('snooze:off', async (ctx) => {
  updateUser(ctx.chat.id, { snoozedUntil: 0 });
  await safeAnswer(ctx, '🔔 Alerts back on!');
  const user = getUser(ctx.chat.id);
  await safeEdit(ctx, text.snooze(user), { parse_mode: 'Markdown', ...menu.snooze(user) });
});

bot.action(/^snooze:alert:(\d+)$/, async (ctx) => {
  const mins = parseInt(ctx.match[1], 10);
  if (isNaN(mins) || mins < 0 || mins > 1440) return safeAnswer(ctx, '❌ Invalid snooze duration');
  updateUser(ctx.chat.id, { snoozedUntil: Date.now() + mins * 60000 });
  const label = mins >= 60 ? `${mins/60}h` : `${mins}m`;
  await safeAnswer(ctx, `🔕 Snoozed for ${label}. Alerts paused.`);
  try { await ctx.editMessageReplyMarkup(undefined); } catch (_) {}
});

bot.action(/^quiet:(\d+):(\d+)$/, async (ctx) => {
  const start = parseInt(ctx.match[1], 10);
  const end = parseInt(ctx.match[2], 10);
  if (isNaN(start) || isNaN(end) || start < 0 || start > 23 || end < 0 || end > 23) return safeAnswer(ctx, '❌ Invalid hours (0-23)');
  updateUser(ctx.chat.id, { quietStart: start, quietEnd: end });
  await safeAnswer(ctx, `🌙 Quiet hours set!`);
  const user = getUser(ctx.chat.id);
  await safeEdit(ctx, text.quiet(user), { parse_mode: 'Markdown', ...menu.quiet(user) });
});

bot.action('quiet:off', async (ctx) => {
  updateUser(ctx.chat.id, { quietStart: null, quietEnd: null });
  await safeAnswer(ctx, '🔔 Quiet hours off');
  const user = getUser(ctx.chat.id);
  await safeEdit(ctx, text.quiet(user), { parse_mode: 'Markdown', ...menu.quiet(user) });
});

// ═══════════════════════════════════════════════════════════════════════════════
// BROWSE
// ═══════════════════════════════════════════════════════════════════════════════
bot.action(/^browse:(\d+)$/, async (ctx) => {
  await safeAnswer(ctx);
  const user = getUser(ctx.chat.id);
  await safeEdit(ctx, `💎 *Browse Pools*\n\nTap to add to your watchlist:`, { parse_mode: 'Markdown', ...menu.browse(parseInt(ctx.match[1]), user) });
});

// ═══════════════════════════════════════════════════════════════════════════════
// INPUT
// ═══════════════════════════════════════════════════════════════════════════════
bot.action('input:wallet', async (ctx) => {
  await safeAnswer(ctx);
  setUserState(ctx.chat.id, { awaiting: 'wallet' });
  await safeEdit(ctx, text.addWallet(), { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'nav:wallets')]]) });
});

bot.action('input:search', async (ctx) => {
  await safeAnswer(ctx);
  setUserState(ctx.chat.id, { awaiting: 'search' });
  await safeEdit(ctx, text.search(), { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'nav:watchlist')]]) });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIRM & DO
// ═══════════════════════════════════════════════════════════════════════════════
// Specific confirm handlers (rmtoken, rmpool, rmwhale) are below — no generic catch-all needed

bot.action('confirm:resetstats', async (ctx) => {
  await safeAnswer(ctx);
  await safeEdit(ctx, `⚠️ *Reset Statistics?*\n\nThis will clear all your stats and history.`, { parse_mode: 'Markdown', ...menu.confirm('resetstats', 'reset everything') });
});

bot.action('confirm:clearwatchlist', async (ctx) => {
  await safeAnswer(ctx);
  await safeEdit(ctx, `⚠️ *Clear Watchlist?*\n\nThis will remove all items from your watchlist.`, { parse_mode: 'Markdown', ...menu.confirm('clearwatchlist', 'clear all') });
});

bot.action(/^do:rmwallet:(.+)$/, async (ctx) => {
  const wallet = ctx.match[1];
  const user = getUser(ctx.chat.id);
  if (user) {
    user.wallets = (user.wallets || []).filter(w => w !== wallet);
    saveUsersDebounced();  // Debounced for performance
    refreshWalletSubscriptions();
  }
  await safeAnswer(ctx, '✅ Wallet removed');
  await safeEdit(ctx, text.wallets(user), { parse_mode: 'Markdown', ...menu.wallets(user) });
});

bot.action(/^do:rmtoken:(.+)$/, async (ctx) => {
  const token = ctx.match[1];
  const user = getUser(ctx.chat.id);
  if (user) {
    user.trackedTokens = (user.trackedTokens || []).filter(t => t !== token);
    saveUsersDebounced();  // Debounced for performance
  }
  await safeAnswer(ctx, '✅ Token removed');
  await safeEdit(ctx, text.watchlist(user), { parse_mode: 'Markdown', ...menu.watchlist(user) });
});

bot.action(/^do:rmpool:(.+)$/, async (ctx) => {
  const poolId = ctx.match[1];
  const user = getUser(ctx.chat.id);
  if (user) {
    user.watchlist = (user.watchlist || []).filter(id => id !== poolId);
    saveUsersDebounced();  // Debounced for performance
  }
  await safeAnswer(ctx, '✅ Pool removed');
  await safeEdit(ctx, text.watchlist(user), { parse_mode: 'Markdown', ...menu.watchlist(user) });
});

bot.action('do:resetstats', async (ctx) => {
  updateUser(ctx.chat.id, {
    stats: { cipherBuys: 0, cipherSells: 0, cipherLp: 0, otherLp: 0, otherTrades: 0, walletAlerts: 0, events: 0, volume: 0 },
    todayStats: { trades: 0, lp: 0, wallet: 0, events: 0, lastReset: Date.now() },
    recentAlerts: [],
  });
  await safeAnswer(ctx, '✅ Stats reset');
  const user = getUser(ctx.chat.id);
  await safeEdit(ctx, text.settings(user), { parse_mode: 'Markdown', ...menu.settings(user) });
});

bot.action('do:clearwatchlist', async (ctx) => {
  updateUser(ctx.chat.id, { watchlist: [], trackedTokens: [] });
  await safeAnswer(ctx, '✅ Watchlist cleared');
  const user = getUser(ctx.chat.id);
  await safeEdit(ctx, text.watchlist(user), { parse_mode: 'Markdown', ...menu.watchlist(user) });
});

// Token removal confirmation
bot.action(/^confirm:rmtoken:(.+)$/, async (ctx) => {
  await safeAnswer(ctx);
  const mint = ctx.match[1];
  const symbol = getSymbol(mint);

  await safeEdit(ctx, `⚠️ *Remove Token?*\n\n🪙 ${symbol}\n\nRemove from your watchlist?`, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('🗑️ Yes, Remove', `do:rmtoken:${mint}`)],
      [Markup.button.callback('« Cancel', 'nav:watchlist')],
    ])
  });
});

// Pool removal confirmation
bot.action(/^confirm:rmpool:(.+)$/, async (ctx) => {
  await safeAnswer(ctx);
  const poolId = ctx.match[1];
  const pool = poolMap.get(poolId);
  const pairName = pool?.pairName || 'Pool';

  await safeEdit(ctx, `⚠️ *Remove Pool?*\n\n💧 ${escMd(pairName)}\n\nRemove from your watchlist?`, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('🗑️ Yes, Remove', `do:rmpool:${poolId}`)],
      [Markup.button.callback('« Cancel', 'nav:watchlist')],
    ])
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ADD/REMOVE
// ═══════════════════════════════════════════════════════════════════════════════
bot.action(/^add:pool:([^:]+):browse:(\d+)$/, async (ctx) => {
  const poolId = ctx.match[1];
  const page = parseInt(ctx.match[2]);
  const user = getUser(ctx.chat.id);
  if (user) {
    user.watchlist = user.watchlist || [];
    const totalItems = (user.watchlist?.length || 0) + (user.trackedTokens?.length || 0);
    if (totalItems >= CONFIG.maxWatchlistItems) {
      await safeAnswer(ctx, `Watchlist full (${CONFIG.maxWatchlistItems} max)`);
    } else if (!user.watchlist.includes(poolId)) {
      user.watchlist.push(poolId);
      saveUsersDebounced();
      const pool = poolMap.get(poolId);
      await safeAnswer(ctx, `✅ Added ${pool?.pairName || ''}`);
    } else {
      await safeAnswer(ctx, 'Already in watchlist');
    }
  }
  await safeEdit(ctx, `💎 *Browse Pools*\n\nTap to add to your watchlist:`, { parse_mode: 'Markdown', ...menu.browse(page, user) });
});

bot.action(/^rm:pool:([^:]+):browse:(\d+)$/, async (ctx) => {
  const poolId = ctx.match[1];
  const page = parseInt(ctx.match[2]);
  const user = getUser(ctx.chat.id);
  if (user) {
    user.watchlist = (user.watchlist || []).filter(id => id !== poolId);
    saveUsersDebounced();  // Debounced for performance
  }
  await safeAnswer(ctx, '✅ Removed');
  await safeEdit(ctx, `💎 *Browse Pools*\n\nTap to add to your watchlist:`, { parse_mode: 'Markdown', ...menu.browse(page, user) });
});

bot.action(/^add:pool:([^:]+):alert$/, async (ctx) => {
  const poolId = ctx.match[1];
  const user = getUser(ctx.chat.id);
  if (user) {
    user.watchlist = user.watchlist || [];
    if (!user.watchlist.includes(poolId)) {
      user.watchlist.push(poolId);
      saveUsersDebounced();  // Debounced for performance
      const pool = poolMap.get(poolId);
      await safeAnswer(ctx, `✅ Added ${pool?.pairName || ''} to watchlist`);
    } else {
      await safeAnswer(ctx, 'Already in watchlist');
    }
  }
});

bot.action(/^add:pool:([^:]+)$/, async (ctx) => {
  const poolId = ctx.match[1];
  const user = getUser(ctx.chat.id);
  if (user) {
    user.watchlist = user.watchlist || [];
    const totalItems = (user.watchlist?.length || 0) + (user.trackedTokens?.length || 0);
    if (totalItems >= CONFIG.maxWatchlistItems) {
      await safeAnswer(ctx, `Watchlist full (${CONFIG.maxWatchlistItems} max)`);
    } else if (!user.watchlist.includes(poolId)) {
      user.watchlist.push(poolId);
      saveUsersDebounced();
      const pool = poolMap.get(poolId);
      await safeAnswer(ctx, `✅ Added ${pool?.pairName || ''}`);
    } else {
      await safeAnswer(ctx, 'Already in watchlist');
    }
  }
  await safeEdit(ctx, text.watchlist(user), { parse_mode: 'Markdown', ...menu.watchlist(user) });
});

bot.action(/^rm:pool:(.+)$/, async (ctx) => {
  const poolId = ctx.match[1];
  const user = getUser(ctx.chat.id);
  if (user) {
    user.watchlist = (user.watchlist || []).filter(id => id !== poolId);
    saveUsersDebounced();  // Debounced for performance
  }
  await safeAnswer(ctx, '✅ Removed');
  await safeEdit(ctx, text.watchlist(user), { parse_mode: 'Markdown', ...menu.watchlist(user) });
});

bot.action(/^add:token:(.+)$/, async (ctx) => {
  const mint = ctx.match[1];
  const user = getUser(ctx.chat.id);
  if (user) {
    user.trackedTokens = user.trackedTokens || [];
    if (!user.trackedTokens.includes(mint)) user.trackedTokens.push(mint);
    saveUsersDebounced();  // Debounced for performance
  }
  await safeAnswer(ctx, `✅ Now tracking ${getSymbol(mint)}`);
  await safeEdit(ctx, text.watchlist(user), { parse_mode: 'Markdown', ...menu.watchlist(user) });
});

bot.action(/^rm:token:(.+)$/, async (ctx) => {
  const mint = ctx.match[1];
  const user = getUser(ctx.chat.id);
  if (user) {
    user.trackedTokens = (user.trackedTokens || []).filter(t => t !== mint);
    saveUsersDebounced();  // Debounced for performance
  }
  await safeAnswer(ctx, '✅ Stopped tracking');
  await safeEdit(ctx, text.watchlist(user), { parse_mode: 'Markdown', ...menu.watchlist(user) });
});

bot.action(/^addall:(.+)$/, async (ctx) => {
  const mint = ctx.match[1];
  const user = getUser(ctx.chat.id);
  const tokenPools = findPoolsByToken(mint);
  if (user) {
    user.watchlist = user.watchlist || [];
    let added = 0;
    tokenPools.forEach(p => { 
      if (!user.watchlist.includes(p.id)) {
        user.watchlist.push(p.id);
        added++;
      }
    });
    saveUsersDebounced();  // Debounced for performance
    await safeAnswer(ctx, `✅ Added ${added} pools`);
  }
  await safeEdit(ctx, text.watchlist(user), { parse_mode: 'Markdown', ...menu.watchlist(user) });
});

// ═══════════════════════════════════════════════════════════════════════════════
// VIEW
// ═══════════════════════════════════════════════════════════════════════════════
bot.action(/^view:wallet:(.+)$/, async (ctx) => {
  await safeAnswer(ctx);
  const wallet = ctx.match[1];
  await safeEdit(ctx, `👛 *Whale Wallet*\n\n\`${wallet}\`\n\n_Tracking activity from this wallet_`, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [
        Markup.button.url('🔍 Solscan', `https://solscan.io/account/${wallet}`),
        Markup.button.url('🦅 Birdeye', `https://birdeye.so/profile/${wallet}?chain=solana`),
      ],
      [Markup.button.callback('🗑️ Remove Wallet', `confirm:rmwhale:${wallet}`)],
      [Markup.button.callback('« Back', 'nav:wallets'), Markup.button.callback('🏠 Menu', 'nav:main')],
    ])
  });
});

// Handler to confirm whale wallet removal
bot.action(/^confirm:rmwhale:(.+)$/, async (ctx) => {
  await safeAnswer(ctx);
  const wallet = ctx.match[1];

  await safeEdit(ctx, `⚠️ *Remove Whale Wallet?*\n\n\`${wallet}\`\n\nYou'll stop receiving alerts for this wallet.`, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('🗑️ Yes, Remove', `do:rmwhale:${wallet}`)],
      [Markup.button.callback('« Cancel', 'nav:wallets')],
    ])
  });
});

// Execute whale wallet removal
bot.action(/^do:rmwhale:(.+)$/, async (ctx) => {
  const wallet = ctx.match[1];
  const user = getUser(ctx.chat.id);
  
  if (!user) {
    await safeAnswer(ctx, 'Error');
    return;
  }
  
  // Remove from whale wallets array
  user.wallets = (user.wallets || []).filter(w => w !== wallet);
  saveUsersDebounced();  // Debounced for performance
  
  // Refresh subscriptions
  refreshWalletSubscriptions();
  
  await safeAnswer(ctx, '✅ Wallet removed');
  await safeEdit(ctx, text.wallets(user), { parse_mode: 'Markdown', ...menu.wallets(user) });
});

bot.action(/^view:token:(.+)$/, async (ctx) => {
  await safeAnswer(ctx, '🔄 Loading...');
  const mint = ctx.match[1];
  const user = getUser(ctx.chat.id);
  const tokenPools = findPoolsByToken(mint);
  const price = getPrice(mint);
  
  // Try to get enhanced data from Birdeye
  let overviewText = '';
  const overview = await getTokenOverview(mint);
  
  if (overview) {
    const priceChange = overview.priceChange24h;
    const changeIcon = priceChange >= 0 ? '📈' : '📉';
    const changeStr = priceChange ? `${changeIcon} ${priceChange >= 0 ? '+' : ''}${priceChange.toFixed(2)}%` : '';
    
    overviewText = `
💰 *Price:* ${overview.price ? fmtPrice(overview.price) : 'N/A'} ${changeStr}
📊 *24h Vol:* ${overview.volume24h ? fmt(overview.volume24h) : 'N/A'}
💧 *Liquidity:* ${overview.liquidity ? fmt(overview.liquidity) : 'N/A'}
🏦 *MC:* ${overview.mc ? fmt(overview.mc) : 'N/A'}
👥 *Holders:* ${overview.holders ? overview.holders.toLocaleString() : 'N/A'}
🔄 *24h Trades:* ${overview.trades24h || 'N/A'}`;
  } else {
    const priceStr = price ? `\n💰 *Price:* ${fmtPrice(price)}` : '';
    overviewText = priceStr;
  }
  
  const msg = `🪙 *${getSymbol(mint)}*

\`${mint}\`
${overviewText}

*${tokenPools.length} pool${tokenPools.length !== 1 ? 's' : ''} on Orbit:*`;

  await safeEdit(ctx, msg, { parse_mode: 'Markdown', ...menu.tokenPools(mint, user) });
});

bot.action(/^view:pool:(.+)$/, async (ctx) => {
  await safeAnswer(ctx);
  const poolId = ctx.match[1];
  const pool = poolMap.get(poolId);
  const user = getUser(ctx.chat.id);

  if (!pool) {
    await safeEdit(ctx, `❌ *Pool Not Found*\n\nThis pool may have been removed.`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('⭐ Watchlist', 'nav:watchlist'), Markup.button.callback('🏠 Menu', 'nav:main')]])
    });
    return;
  }

  const inList = user?.watchlist?.includes(poolId);
  const baseMint = pool.baseMint || pool.base;
  await safeEdit(ctx, text.poolView(pool), {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('📊 Chart', `chart:${poolId}:1h`),
       Markup.button.callback('💧 LP History', `liqhistory:${poolId}`)],
      [Markup.button.callback(inList ? '❌ Remove from Watchlist' : '➕ Add to Watchlist', inList ? `confirm:rmpool:${poolId}` : `add:pool:${poolId}`)],
      [
        Markup.button.url('🔍 Solscan', `https://solscan.io/account/${poolId}`),
        Markup.button.url('🦅 Birdeye', `https://birdeye.so/token/${baseMint}?chain=solana`),
      ],
      [Markup.button.callback('« Back', 'nav:watchlist'), Markup.button.callback('🏠 Menu', 'nav:main')],
    ])
  });
});

bot.action('noop', (ctx) => safeAnswer(ctx));
bot.action('noop_alert', (ctx) => safeAnswer(ctx, 'No transaction link available'));

// ═══════════════════════════════════════════════════════════════════════════════
// TEXT HANDLER
// ═══════════════════════════════════════════════════════════════════════════════
bot.on('text', async (ctx) => {
  const state = getUserState(ctx.chat.id);
  if (!state?.awaiting) return;
  
  userStates.delete(ctx.chat.id);
  const input = ctx.message.text.trim();
  const user = getUser(ctx.chat.id) || createUser(ctx.chat.id);
  
  try {
    if (state.awaiting === 'wallet') {
      if (!isValidWallet(input)) {
        await ctx.reply('❌ *Invalid address*\n\nPlease enter a valid Solana wallet address.', { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🔄 Try Again', 'input:wallet')], [Markup.button.callback('« Back', 'nav:wallets')]]) });
        return;
      }
      if (user.wallets?.includes(input)) {
        await ctx.reply('⚠️ *Already tracking*\n\nThis wallet is already in your list.', { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('« Back', 'nav:wallets')]]) });
        return;
      }
      if ((user.wallets?.length || 0) >= CONFIG.maxWalletsPerUser) {
        await ctx.reply(`⚠️ *Limit reached*\n\nYou can track up to ${CONFIG.maxWalletsPerUser} wallets. Remove one first.`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('« Manage Wallets', 'nav:wallets')]]) });
        return;
      }
      
      user.wallets = user.wallets || [];
      user.wallets.push(input);
      saveUsersDebounced();  // Debounced for performance
      refreshWalletSubscriptions();
      
      await ctx.reply(`✅ *Wallet Added!*\n\n👛 \`${shortAddr(input)}\`\n\nYou'll get alerts when this wallet trades on Orbit.`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
        [Markup.button.callback('➕ Add Another', 'input:wallet')],
        [Markup.button.callback('✓ Done', 'nav:wallets')],
      ])});
    }
    
    if (state.awaiting === 'search') {
      // Sanitize search input
      const searchQuery = sanitizeInput(input, 50);
      
      if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(searchQuery)) {
        const tokenPools = findPoolsByToken(searchQuery);
        if (tokenPools.length === 0) {
          await ctx.reply('❌ *No pools found*\n\nThis token doesn\'t have any Orbit pools.', { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🔄 Try Again', 'input:search')], [Markup.button.callback('« Back', 'nav:watchlist')]]) });
          return;
        }
        const price = getPrice(searchQuery);
        const priceStr = price ? `\n💰 Price: ${fmtPrice(price)}` : '';
        await ctx.reply(`🪙 *${getSymbol(searchQuery)}*${priceStr}\n\n*${tokenPools.length} pool${tokenPools.length !== 1 ? 's' : ''} found:*`, { parse_mode: 'Markdown', ...menu.tokenPools(searchQuery, user) });
      } else {
        const results = searchPools(searchQuery);
        if (results.length === 0) {
          await ctx.reply(`❌ *No results for "${escMd(searchQuery)}"*\n\nTry a different search term.`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🔍 Try Again', 'input:search')], [Markup.button.callback('« Back', 'nav:watchlist')]]) });
          return;
        }
        await ctx.reply(`🔍 *Results for "${escMd(searchQuery)}"*\n\n*${results.length} pool${results.length !== 1 ? 's' : ''} found:*`, { parse_mode: 'Markdown', ...menu.searchResults(results, user) });
      }
    }
    
    // Pool Explorer search
    if (state.awaiting === 'poolSearch') {
      const searchQuery = sanitizeInput(input, 50);
      
      // Check if it's a token address
      if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(searchQuery)) {
        const tokenPools = findPoolsByToken(searchQuery);
        if (tokenPools.length === 0) {
          await ctx.reply('❌ *No pools found*\n\nThis token doesn\'t have any Orbit pools.', { 
            parse_mode: 'Markdown', 
            ...Markup.inlineKeyboard([[Markup.button.callback('🔍 Try Again', 'pools:search')], [Markup.button.callback('« Back', 'nav:pools')]]) 
          });
          return;
        }
        const pool = tokenPools[0];
        await ctx.reply(text.poolView(pool), { parse_mode: 'Markdown', ...menu.poolView(pool, user) });
      } else {
        // Search by name/symbol
        const results = searchPools(searchQuery);
        if (results.length === 0) {
          await ctx.reply(`❌ *No results for "${escMd(searchQuery)}"*\n\nTry a different search term.`, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('🔍 Try Again', 'pools:search')], [Markup.button.callback('« Back', 'nav:pools')]])
          });
          return;
        }
        
        // Show search results with pool buttons
        const btns = results.slice(0, 8).map(p => {
          const pairName = p.pairName || formatPair(p.baseMint || p.base, p.quoteMint || p.quote);
          const vol = orbitVolumes.pools?.[p.id]?.volume24h || 0;
          const icon = p.isCipher ? '🔷' : '🌐';
          return [Markup.button.callback(`${icon} ${pairName} • ${fmtCompact(vol)}`, `pool:view:${p.id}`)];
        });
        btns.push([Markup.button.callback('🔍 Search Again', 'pools:search'), Markup.button.callback('« Back', 'nav:pools')]);
        
        await ctx.reply(`🔍 *Results for "${escMd(searchQuery)}"*\n\n*${results.length} pool${results.length !== 1 ? 's' : ''} found:*`, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard(btns)
        });
      }
    }
    
    // Portfolio wallet input (supports both legacy and new multi-wallet)
    if (state.awaiting === 'mywallet' || state.awaiting === 'portfoliowallet') {
      if (!isValidWallet(input)) {
        await ctx.reply('❌ Invalid Solana address. Try again:', { 
          parse_mode: 'Markdown', 
          ...Markup.inlineKeyboard([[Markup.button.callback('« Cancel', state.awaiting === 'portfoliowallet' ? 'portfolio:wallets' : 'nav:portfolio')]]) 
        });
        setUserState(ctx.chat.id, { awaiting: state.awaiting }); // Keep waiting for input
        return;
      }
      
      // Check if wallet already exists
      const existingWallets = user.portfolioWallets || [];
      if (existingWallets.includes(input) || user.myWallet === input) {
        await ctx.reply('⚠️ This wallet is already in your portfolio.', { 
          parse_mode: 'Markdown', 
          ...Markup.inlineKeyboard([[Markup.button.callback('« Back', 'portfolio:wallets')]]) 
        });
        return;
      }
      
      // Check wallet limit
      const currentCount = existingWallets.length || (user.myWallet ? 1 : 0);
      if (currentCount >= 5) {
        await ctx.reply('❌ Maximum 5 wallets allowed. Remove one first.', { 
          parse_mode: 'Markdown', 
          ...Markup.inlineKeyboard([[Markup.button.callback('« Back', 'portfolio:wallets')]]) 
        });
        return;
      }
      
      // Add wallet to portfolioWallets array
      if (!user.portfolioWallets) {
        user.portfolioWallets = user.myWallet ? [user.myWallet] : [];
      }
      if (!user.portfolioWallets.includes(input)) {
        user.portfolioWallets.push(input);
      }
      
      // Set myWallet if it's the first wallet (for backward compatibility)
      if (!user.myWallet) {
        user.myWallet = input;
      }
      
      saveUsersDebounced();  // Debounced for performance
      
      const loadingMsg = await ctx.reply('🔄 Loading portfolio...');
      
      try {
        await syncPortfolio(ctx.chat.id);
        const updatedUser = getUser(ctx.chat.id);
        
        // Delete loading message and show portfolio
        try { await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id); } catch (e) {}
        
        const walletCount = updatedUser.portfolioWallets?.length || 1;
        await ctx.reply(`✅ Wallet added! (${walletCount}/5)\n\n` + text.portfolio(updatedUser), { parse_mode: 'Markdown', ...menu.portfolio(updatedUser) });
      } catch (e) {
        try { await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id); } catch (e) {}
        const updatedUser = getUser(ctx.chat.id);
        await ctx.reply(`✅ Wallet added!\n\n⚠️ Couldn't load data. Tap Refresh to retry.`, { parse_mode: 'Markdown', ...menu.portfolio(updatedUser) });
      }
    }
  } catch (e) {
    log.error('Text handler error:', e.message);
    try { await ctx.reply('❌ Something went wrong. Please try again.'); } catch (e2) {}
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ALERTS
// ═══════════════════════════════════════════════════════════════════════════════

// Format large numbers nicely (uses numeral)
function fmtAmount(num, decimals = 2) {
  return formatNumber(num, decimals);
}

// Get size tier for visual indicator
function getSizeTier(usd) {
  if (usd >= 100000) return { tier: 'WHALE', bar: '█████' };
  if (usd >= 50000) return { tier: 'LARGE', bar: '████░' };
  if (usd >= 10000) return { tier: 'MEDIUM', bar: '███░░' };
  if (usd >= 1000) return { tier: 'SMALL', bar: '██░░░' };
  return { tier: 'MICRO', bar: '█░░░░' };
}

// ═══════════════════════════════════════════════════════════════════════════════
// DAILY DIGEST
// ═══════════════════════════════════════════════════════════════════════════════
async function sendDailyDigests() {
  const solPrice = getPrice(MINTS.SOL);
  const cipherPrice = getPrice(MINTS.CIPHER);
  const vol24h = orbitVolumes.total24h || 0;
  
  let sent = 0;
  let errors = 0;
  
  for (const user of users.values()) {
    // Only send to users who have enabled daily digest and aren't blocked
    if (!user.dailyDigest || user.blocked || !user.enabled) continue;
    
    try {
      const stats = user.todayStats || { trades: 0, lp: 0, wallet: 0 };
      const allTimeStats = user.stats || {};
      const portfolio = user.portfolio || {};
      
      // Build portfolio section if user has wallets
      let portfolioSection = '';
      if (user.portfolioWallets?.length > 0 || user.myWallet) {
        const totalValue = portfolio.totalValue || 0;
        const pnl = portfolio.realizedPnl || 0;
        const pnlIcon = pnl >= 0 ? '🟢' : '🔴';
        portfolioSection = `
📈 *Your Portfolio*
💎 Net Worth: ${fmt(totalValue)}
${pnlIcon} PnL: ${pnl >= 0 ? '+' : '-'}${fmt(Math.abs(pnl))}
`;
      }
      
      // Build the digest message
      const msg = `☀️ *Good Morning!*

📊 *Daily Digest* — ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' })}

*Market Snapshot*
◎ SOL: ${solPrice ? `$${solPrice.toFixed(2)}` : 'N/A'}
🔷 CIPHER: ${cipherPrice ? fmtPrice(cipherPrice) : 'N/A'}
💹 Orbit 24h Volume: ${fmt(vol24h)}
${portfolioSection}
*Your Activity (24h)*
📊 Trade Alerts: ${stats.trades}
💧 LP Alerts: ${stats.lp}
👛 Wallet Alerts: ${stats.wallet}
🔔 Event Alerts: ${stats.events || 0}

*All Time*
📈 Total Volume Tracked: ${fmt(allTimeStats.volume || 0)}
🔄 Total Alerts: ${(allTimeStats.cipherBuys || 0) + (allTimeStats.cipherSells || 0) + (allTimeStats.cipherLp || 0) + (allTimeStats.otherLp || 0) + (allTimeStats.otherTrades || 0) + (allTimeStats.walletAlerts || 0) + (allTimeStats.events || 0)}

_Have a great day! 🚀_`;

      await bot.telegram.sendMessage(user.chatId, msg, { 
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📈 Portfolio', 'nav:portfolio'), Markup.button.callback('💰 Prices', 'cmd:refreshprice')],
          [Markup.button.callback('⚙️ Digest Settings', 'nav:settings')],
        ])
      });
      
      sent++;
      
      // Rate limit protection
      if (sent % 20 === 0) {
        await new Promise(r => setTimeout(r, 1000));
      }
      
    } catch (e) {
      errors++;
      if (e.code === 429) {
        await new Promise(r => setTimeout(r, (e.parameters?.retry_after || 5) * 1000));
        i--; // Retry this user after rate limit delay
      } else if (e.code === 403 || e.description?.includes('blocked') || e.description?.includes('deactivated')) {
        user.enabled = false;
        user.blocked = true;
        saveUserDebounced(user);
      }
      log.debug(`Digest failed for ${user.chatId}:`, e.message);
    }
  }
  
  // Reset todayStats for all users after digest is sent
  for (const user of users.values()) {
    user.todayStats = { trades: 0, lp: 0, wallet: 0, events: 0, lastReset: Date.now() };
  }
  saveUsersDebounced();

  log.info(`📬 Daily digest: sent ${sent}, errors ${errors}`);
}

async function broadcastTradeAlert({ pool, trade, usd, isBuy, sig }) {
  const toNotify = [];
  
  for (const user of users.values()) {
    if (!user.enabled || user.blocked || isUserSnoozed(user)) continue;
    
    let shouldSend = false;
    
    if (pool.isCipher) {
      const threshold = user.cipherThreshold ?? 100;
      if (isBuy && user.cipherBuys && usd >= threshold) shouldSend = true;
      if (!isBuy && user.cipherSells && usd >= threshold) shouldSend = true;
    } else {
      if (user.trackOtherPools === false) continue;
      const base = pool.baseMint || pool.base;
      const quote = pool.quoteMint || pool.quote;
      const tokenTracked = user.trackedTokens?.includes(base) || user.trackedTokens?.includes(quote);
      const poolWatched = user.watchlist?.includes(pool.id);
      const threshold = user.otherThreshold ?? 500;
      if ((tokenTracked || poolWatched) && usd >= threshold) {
        if (isBuy && user.otherBuys) shouldSend = true;
        if (!isBuy && user.otherSells) shouldSend = true;
      }
    }
    
    if (shouldSend) toNotify.push(user);
  }
  
  if (toNotify.length === 0) return;
  
  // ═══════════════════════════════════════════════════════════════════
  // PROFESSIONAL TRADE ALERT FORMAT
  // ═══════════════════════════════════════════════════════════════════
  const base = pool.baseMint || pool.base;
  const quote = pool.quoteMint || pool.quote;
  const baseSymbol = getSymbol(base);
  const quoteSymbol = getSymbol(quote);
  const baseDecimals = getDecimals(base);
  const quoteDecimals = getDecimals(quote);
  
  const size = getSizeTier(usd);
  const isCipher = pool.isCipher;
  
  // Header with visual distinction
  let header;
  if (isBuy) {
    header = isCipher
      ? `🔷🟢 ━━━━ *BUY* ━━━━ 🟢🔷`
      : `🟢 ━━━━━ *BUY* ━━━━━ 🟢`;
  } else {
    header = isCipher
      ? `🔷🔴 ━━━━ *SELL* ━━━━ 🔴🔷`
      : `🔴 ━━━━━ *SELL* ━━━━━ 🔴`;
  }
  
  // Extract amounts
  let baseAmt = 0, quoteAmt = 0;
  if (trade.amountIn && trade.amountOut) {
    if (isBuy) {
      quoteAmt = parseFloat(trade.amountIn || 0) / Math.pow(10, quoteDecimals);
      baseAmt = parseFloat(trade.amountOut || 0) / Math.pow(10, baseDecimals);
    } else {
      baseAmt = parseFloat(trade.amountIn || 0) / Math.pow(10, baseDecimals);
      quoteAmt = parseFloat(trade.amountOut || 0) / Math.pow(10, quoteDecimals);
    }
  }
  
  // Build the message
  let msg = `${header}
*${escMd(pool.pairName)}*

💵 *${fmt(usd)}*
${size.bar} ${size.tier}
`;

  // Add token flow
  if (baseAmt > 0 && quoteAmt > 0) {
    if (isBuy) {
      msg += `
┌ *Spent:* ${fmtAmount(quoteAmt)} ${quoteSymbol}
└ *Got:* ${fmtAmount(baseAmt)} ${baseSymbol}`;
    } else {
      msg += `
┌ *Sold:* ${fmtAmount(baseAmt)} ${baseSymbol}
└ *Got:* ${fmtAmount(quoteAmt)} ${quoteSymbol}`;
    }
  }
  
  // Trader address
  const trader = trade.wallet || trade.user || trade.owner || trade.maker || trade.taker;
  if (trader) {
    msg += `\n\n👤 \`${shortAddr(trader)}\``;
  }

  // Footer
  msg += `\n⏱ ${fmtTime()} UTC • Orbit`;

  // Send with small delays to avoid Telegram rate limits
  for (let i = 0; i < toNotify.length; i++) {
    const user = toNotify[i];
    try {
      await bot.telegram.sendMessage(user.chatId, msg, { 
        parse_mode: 'Markdown', 
        disable_web_page_preview: true,
        ...menu.alertActions(pool.id, sig)
      });
      
      if (pool.isCipher) isBuy ? user.stats.cipherBuys++ : user.stats.cipherSells++;
      else user.stats.otherTrades++;
      user.stats.volume += usd;
      user.todayStats.trades++;
      
      addRecentAlert(user.chatId, { type: 'trade', pair: pool.pairName, usd, isBuy, sig });
      
      // Small delay every 20 messages to avoid rate limits
      if (i > 0 && i % 20 === 0) await new Promise(r => setTimeout(r, 100));
    } catch (e) {
      if (e.code === 429) {
        await new Promise(r => setTimeout(r, (e.parameters?.retry_after || 5) * 1000));
        i--; // Retry this user after rate limit delay
      } else if (e.code === 403 || e.description?.includes('blocked') || e.description?.includes('deactivated')) {
        user.enabled = false;
        user.blocked = true;
      }
    }
  }
  saveUsersDebounced();  // Debounced for performance
}

async function broadcastLpAlert({ pool, isAdd, usd, sig, msg: originalMsg }) {
  const toNotify = [];
  
  for (const user of users.values()) {
    if (!user.enabled || user.blocked || isUserSnoozed(user)) continue;
    
    let shouldSend = false;
    
    if (pool.isCipher) {
      const threshold = user.cipherThreshold ?? 100;
      if (isAdd && user.cipherLpAdd && usd >= threshold) shouldSend = true;
      if (!isAdd && user.cipherLpRemove && usd >= threshold) shouldSend = true;
    } else {
      if (user.trackOtherPools === false) continue;
      const threshold = user.otherLpThreshold ?? 500;
      if (isAdd && user.otherLpAdd && usd >= threshold) shouldSend = true;
      if (!isAdd && user.otherLpRemove && usd >= threshold) shouldSend = true;
    }
    
    if (shouldSend) toNotify.push(user);
  }
  
  if (toNotify.length === 0) return;
  
  // ═══════════════════════════════════════════════════════════════════
  // PROFESSIONAL LP ALERT FORMAT
  // ═══════════════════════════════════════════════════════════════════
  const base = pool.baseMint || pool.base;
  const quote = pool.quoteMint || pool.quote;
  const baseSymbol = getSymbol(base);
  const quoteSymbol = getSymbol(quote);
  const baseDecimals = getDecimals(base);
  const quoteDecimals = getDecimals(quote);
  
  const size = getSizeTier(usd);
  const isCipher = pool.isCipher;
  
  // Header - distinctive LP style
  let header;
  if (isAdd) {
    header = isCipher
      ? `🔷 ━━━ *LIQUIDITY ADDED* ━━━ 🔷`
      : `💧 ━━━ *LIQUIDITY ADDED* ━━━ 💧`;
  } else {
    header = isCipher
      ? `🔷 ━━━ *LIQUIDITY REMOVED* ━━━ 🔷`
      : `🔥 ━━━ *LIQUIDITY REMOVED* ━━━ 🔥`;
  }
  
  // Build message
  let alertMsg = `${header}
*${escMd(pool.pairName)}*

💵 *${fmt(usd)}*
${size.bar} ${size.tier}
`;

  // Add LP amounts if available
  if (originalMsg) {
    let baseAmt = 0, quoteAmt = 0;
    
    // Try different field names
    if (originalMsg.baseAmount && originalMsg.quoteAmount) {
      baseAmt = parseFloat(originalMsg.baseAmount) / Math.pow(10, baseDecimals);
      quoteAmt = parseFloat(originalMsg.quoteAmount) / Math.pow(10, quoteDecimals);
    } else if (originalMsg.amountX && originalMsg.amountY) {
      baseAmt = parseFloat(originalMsg.amountX) / Math.pow(10, baseDecimals);
      quoteAmt = parseFloat(originalMsg.amountY) / Math.pow(10, quoteDecimals);
    }
    
    if (baseAmt > 0 || quoteAmt > 0) {
      alertMsg += `
┌ ${fmtAmount(baseAmt)} ${baseSymbol}
└ ${fmtAmount(quoteAmt)} ${quoteSymbol}`;
    }
  }
  
  // Footer
  alertMsg += `

⏱ ${fmtTime()} UTC • Orbit`;

  for (let i = 0; i < toNotify.length; i++) {
    const user = toNotify[i];
    try {
      await bot.telegram.sendMessage(user.chatId, alertMsg, { 
        parse_mode: 'Markdown', 
        disable_web_page_preview: true,
        ...menu.alertActions(pool.id, sig)
      });
      
      pool.isCipher ? user.stats.cipherLp++ : user.stats.otherLp++;
      user.todayStats.lp++;
      
      addRecentAlert(user.chatId, { type: 'lp', pair: pool.pairName, usd, isAdd, sig });
      
      if (i > 0 && i % 20 === 0) await new Promise(r => setTimeout(r, 100));
    } catch (e) {
      if (e.code === 429) {
        await new Promise(r => setTimeout(r, (e.parameters?.retry_after || 5) * 1000));
        i--; // Retry this user after rate limit delay
      } else if (e.code === 403 || e.description?.includes('blocked') || e.description?.includes('deactivated')) {
        user.enabled = false;
        user.blocked = true;
      }
    }
  }
  saveUsersDebounced();  // Debounced for performance
}

async function broadcastWalletAlert({ wallet, signature, tokenSymbol, isBuy, usdValue }) {
  const toNotify = [];
  for (const user of users.values()) {
    if (!user.enabled || user.blocked || !user.walletAlerts || isUserSnoozed(user)) continue;
    if (!user.wallets?.includes(wallet)) continue;
    toNotify.push(user);
  }
  if (toNotify.length === 0) return;

  const size = getSizeTier(usdValue);

  // Header
  const header = isBuy
    ? `🐋 ━━━ *WHALE BUY* ━━━ 🐋`
    : `🐋 ━━━ *WHALE SELL* ━━━ 🐋`;

  const msg = `${header}
*${escMd(tokenSymbol)}*

💵 *${fmt(usdValue)}*
${size.bar} ${size.tier}

┌ *Wallet:* \`${shortAddr(wallet)}\`
└ *Action:* ${isBuy ? '🟢 Bought' : '🔴 Sold'}

⏱ ${fmtTime()} UTC • Orbit`;

  for (let i = 0; i < toNotify.length; i++) {
    const user = toNotify[i];
    try {
      await bot.telegram.sendMessage(user.chatId, msg, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        ...menu.walletAlertActions(signature)
      });

      user.stats.walletAlerts = (user.stats.walletAlerts || 0) + 1;
      user.todayStats.wallet++;

      addRecentAlert(user.chatId, { type: 'wallet', token: tokenSymbol, usd: usdValue, wallet: shortAddr(wallet), sig: signature });

      if (i > 0 && i % 20 === 0) await new Promise(r => setTimeout(r, 100));
    } catch (e) {
      if (e.code === 429) {
        await new Promise(r => setTimeout(r, (e.parameters?.retry_after || 5) * 1000));
        i--; // Retry this user after rate limit delay
      } else if (e.code === 403 || e.description?.includes('blocked') || e.description?.includes('deactivated')) {
        user.enabled = false;
        user.blocked = true;
      }
    }
  }
  saveUsersDebounced();  // Debounced for performance
}

// ═══════════════════════════════════════════════════════════════════════════════
// NEW POOL / LOCK / REWARD ALERTS
// ═══════════════════════════════════════════════════════════════════════════════

async function broadcastNewPoolAlert({ poolId, user: creator, sig, timestamp }) {
  const pool = poolMap.get(poolId);
  const pairName = pool?.pairName || 'Unknown Pool';

  const toNotify = [];
  for (const u of users.values()) {
    if (!u.enabled || u.blocked || isUserSnoozed(u)) continue;
    if (u.newPoolAlerts !== false) toNotify.push(u);
  }
  if (toNotify.length === 0) return;

  const creatorAddr = creator ? `\n👤 Creator: \`${shortAddr(creator)}\`` : '';
  const msg = `🆕 ━━━ *NEW POOL* ━━━ 🆕
*${escMd(pairName)}*
${creatorAddr}
\`${poolId || 'N/A'}\`

⏱ ${fmtTime()} UTC • Orbit`;

  for (let i = 0; i < toNotify.length; i++) {
    const u = toNotify[i];
    try {
      await bot.telegram.sendMessage(u.chatId, msg, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        ...(poolId && sig ? menu.alertActions(poolId, sig) : {}),
      });
      addRecentAlert(u.chatId, { type: 'pool_init', pair: pairName, usd: 0, sig });
      u.stats = u.stats || {}; u.stats.events = (u.stats.events || 0) + 1;
      u.todayStats = u.todayStats || {}; u.todayStats.events = (u.todayStats.events || 0) + 1;
      if (i > 0 && i % 20 === 0) await new Promise(r => setTimeout(r, 100));
    } catch (e) {
      if (e.code === 429) {
        await new Promise(r => setTimeout(r, (e.parameters?.retry_after || 5) * 1000));
        i--; // Retry this user after rate limit delay
      } else if (e.code === 403 || e.description?.includes('blocked') || e.description?.includes('deactivated')) {
        u.enabled = false;
        u.blocked = true;
      }
    }
  }
  saveUsersDebounced();
}

async function broadcastLockAlert({ poolId, isLock, user: actor, sig, timestamp }) {
  const pool = poolMap.get(poolId);
  const pairName = pool?.pairName || 'Unknown Pool';

  const toNotify = [];
  for (const u of users.values()) {
    if (!u.enabled || u.blocked || isUserSnoozed(u)) continue;
    if (u.lockAlerts !== false) toNotify.push(u);
  }
  if (toNotify.length === 0) return;

  const icon = isLock ? '🔒' : '🔓';
  const action = isLock ? 'LIQUIDITY LOCKED' : 'LIQUIDITY UNLOCKED';
  const actorAddr = actor ? `\n👤 \`${shortAddr(actor)}\`` : '';

  const msg = `${icon} ━━━ *${action}* ━━━ ${icon}
*${escMd(pairName)}*
${actorAddr}
⏱ ${fmtTime()} UTC • Orbit`;

  for (let i = 0; i < toNotify.length; i++) {
    const u = toNotify[i];
    try {
      await bot.telegram.sendMessage(u.chatId, msg, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        ...(poolId && sig ? menu.alertActions(poolId, sig) : {}),
      });
      addRecentAlert(u.chatId, { type: isLock ? 'lock' : 'unlock', pair: pairName, usd: 0, sig });
      u.stats = u.stats || {}; u.stats.events = (u.stats.events || 0) + 1;
      u.todayStats = u.todayStats || {}; u.todayStats.events = (u.todayStats.events || 0) + 1;
      if (i > 0 && i % 20 === 0) await new Promise(r => setTimeout(r, 100));
    } catch (e) {
      if (e.code === 429) {
        await new Promise(r => setTimeout(r, (e.parameters?.retry_after || 5) * 1000));
        i--; // Retry this user after rate limit delay
      } else if (e.code === 403 || e.description?.includes('blocked') || e.description?.includes('deactivated')) {
        u.enabled = false;
        u.blocked = true;
      }
    }
  }
  saveUsersDebounced();
}

async function broadcastRewardClaimAlert({ user: claimer, sig, poolId, timestamp }) {
  const pool = poolId ? poolMap.get(poolId) : null;
  const pairName = pool?.pairName || '';

  const toNotify = [];
  for (const u of users.values()) {
    if (!u.enabled || u.blocked || isUserSnoozed(u)) continue;
    if (u.rewardAlerts !== false) toNotify.push(u);
  }
  if (toNotify.length === 0) return;

  const claimerAddr = claimer ? `\n👤 \`${shortAddr(claimer)}\`` : '';
  const poolLine = pairName ? `\n*Pool:* ${escMd(pairName)}` : '';

  const msg = `🎁 ━━━ *REWARDS CLAIMED* ━━━ 🎁
${poolLine}${claimerAddr}

⏱ ${fmtTime()} UTC • Orbit`;

  for (let i = 0; i < toNotify.length; i++) {
    const u = toNotify[i];
    try {
      await bot.telegram.sendMessage(u.chatId, msg, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        ...(sig ? menu.walletAlertActions(sig) : {}),
      });
      addRecentAlert(u.chatId, { type: 'reward', pair: pairName, usd: 0, sig });
      u.stats = u.stats || {}; u.stats.events = (u.stats.events || 0) + 1;
      u.todayStats = u.todayStats || {}; u.todayStats.events = (u.todayStats.events || 0) + 1;
      if (i > 0 && i % 20 === 0) await new Promise(r => setTimeout(r, 100));
    } catch (e) {
      if (e.code === 429) {
        await new Promise(r => setTimeout(r, (e.parameters?.retry_after || 5) * 1000));
        i--; // Retry this user after rate limit delay
      } else if (e.code === 403 || e.description?.includes('blocked') || e.description?.includes('deactivated')) {
        u.enabled = false;
        u.blocked = true;
      }
    }
  }
  saveUsersDebounced();
}

async function broadcastClosePoolAlert({ poolId, user: actor, sig, timestamp }) {
  const pool = poolMap.get(poolId);
  const pairName = pool?.pairName || 'Unknown Pool';

  const toNotify = [];
  for (const u of users.values()) {
    if (!u.enabled || u.blocked || isUserSnoozed(u)) continue;
    if (u.closePoolAlerts !== false) toNotify.push(u);
  }
  if (toNotify.length === 0) return;

  const actorAddr = actor ? `\n👤 \`${shortAddr(actor)}\`` : '';

  const msg = `🚫 ━━━ *POOL CLOSED* ━━━ 🚫
*${escMd(pairName)}*
${actorAddr}
⏱ ${fmtTime()} UTC • Orbit`;

  for (let i = 0; i < toNotify.length; i++) {
    const u = toNotify[i];
    try {
      await bot.telegram.sendMessage(u.chatId, msg, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        ...(sig ? menu.walletAlertActions(sig) : {}),
      });
      addRecentAlert(u.chatId, { type: 'close_pool', pair: pairName, usd: 0, sig });
      u.stats = u.stats || {}; u.stats.events = (u.stats.events || 0) + 1;
      u.todayStats = u.todayStats || {}; u.todayStats.events = (u.todayStats.events || 0) + 1;
      if (i > 0 && i % 20 === 0) await new Promise(r => setTimeout(r, 100));
    } catch (e) {
      if (e.code === 429) {
        await new Promise(r => setTimeout(r, (e.parameters?.retry_after || 5) * 1000));
        i--; // Retry this user after rate limit delay
      } else if (e.code === 403 || e.description?.includes('blocked') || e.description?.includes('deactivated')) {
        u.enabled = false;
        u.blocked = true;
      }
    }
  }
  saveUsersDebounced();
}

async function broadcastProtocolFeeAlert({ poolId, user: actor, sig, timestamp }) {
  const pool = poolId ? poolMap.get(poolId) : null;
  const pairName = pool?.pairName || '';

  const toNotify = [];
  for (const u of users.values()) {
    if (!u.enabled || u.blocked || isUserSnoozed(u)) continue;
    if (u.protocolFeeAlerts !== false) toNotify.push(u);
  }
  if (toNotify.length === 0) return;

  const actorAddr = actor ? `\n👤 \`${shortAddr(actor)}\`` : '';
  const poolLine = pairName ? `\n*Pool:* ${escMd(pairName)}` : '';

  const msg = `💰 ━━━ *PROTOCOL FEES CLAIMED* ━━━ 💰
${poolLine}${actorAddr}
⏱ ${fmtTime()} UTC • Orbit`;

  for (let i = 0; i < toNotify.length; i++) {
    const u = toNotify[i];
    try {
      await bot.telegram.sendMessage(u.chatId, msg, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        ...(sig ? menu.walletAlertActions(sig) : {}),
      });
      addRecentAlert(u.chatId, { type: 'protocol_fees', pair: pairName, usd: 0, sig });
      u.stats = u.stats || {}; u.stats.events = (u.stats.events || 0) + 1;
      u.todayStats = u.todayStats || {}; u.todayStats.events = (u.todayStats.events || 0) + 1;
      if (i > 0 && i % 20 === 0) await new Promise(r => setTimeout(r, 100));
    } catch (e) {
      if (e.code === 429) {
        await new Promise(r => setTimeout(r, (e.parameters?.retry_after || 5) * 1000));
        i--; // Retry this user after rate limit delay
      } else if (e.code === 403 || e.description?.includes('blocked') || e.description?.includes('deactivated')) {
        u.enabled = false;
        u.blocked = true;
      }
    }
  }
  saveUsersDebounced();
}

async function broadcastAdminAlert({ poolId, user: actor, sig, timestamp, eventName }) {
  const pool = poolId ? poolMap.get(poolId) : null;
  const pairName = pool?.pairName || '';

  const toNotify = [];
  for (const u of users.values()) {
    if (!u.enabled || u.blocked || isUserSnoozed(u)) continue;
    if (u.adminAlerts !== false) toNotify.push(u);
  }
  if (toNotify.length === 0) return;

  const subtypes = {
    AdminUpdated: 'Admin Rotated',
    AuthoritiesUpdated: 'Authorities Changed',
    FeeConfigUpdated: 'Fee Config Changed',
    PauseUpdated: 'Pause State Changed',
  };
  const subLabel = subtypes[eventName] || eventName || 'Config Change';
  const actorAddr = actor ? `\n👤 \`${shortAddr(actor)}\`` : '';
  const poolLine = pairName ? `\n*Pool:* ${escMd(pairName)}` : '';

  const msg = `⚠️ ━━━ *ADMIN UPDATE* ━━━ ⚠️
*${escMd(subLabel)}*
${poolLine}${actorAddr}
⏱ ${fmtTime()} UTC • Orbit`;

  for (let i = 0; i < toNotify.length; i++) {
    const u = toNotify[i];
    try {
      await bot.telegram.sendMessage(u.chatId, msg, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        ...(sig ? menu.walletAlertActions(sig) : {}),
      });
      addRecentAlert(u.chatId, { type: 'admin', pair: pairName, usd: 0, sig });
      u.stats = u.stats || {}; u.stats.events = (u.stats.events || 0) + 1;
      u.todayStats = u.todayStats || {}; u.todayStats.events = (u.todayStats.events || 0) + 1;
      if (i > 0 && i % 20 === 0) await new Promise(r => setTimeout(r, 100));
    } catch (e) {
      if (e.code === 429) {
        await new Promise(r => setTimeout(r, (e.parameters?.retry_after || 5) * 1000));
        i--; // Retry this user after rate limit delay
      } else if (e.code === 403 || e.description?.includes('blocked') || e.description?.includes('deactivated')) {
        u.enabled = false;
        u.blocked = true;
      }
    }
  }
  saveUsersDebounced();
}

// ═══════════════════════════════════════════════════════════════════════════════
// ERROR & STARTUP
// ═══════════════════════════════════════════════════════════════════════════════

async function start() {
  log.info('🚀 Orbit Tracker v11.0\n');
  log.info(`📁 Data directory: ${DATA_DIR}`);
  log.info(`🐛 Debug mode: ${CONFIG.debug ? 'ON' : 'OFF'}`);
  
  // Initialize SQLite database first
  if (!initDatabase()) {
    log.error('Failed to initialize database. Exiting.');
    process.exit(1);
  }
  
  try {
    loadUsers();
  } catch (e) {
    log.error('Failed to load users, starting with empty user set:', e.message);
  }
  loadSeenTxs();
  await loadTokens();

  // Retry critical startup fetches up to 3 times
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await fetchPools();
      if (pools.length > 0) break;
      log.warn(`Attempt ${attempt}/3: fetchPools returned 0 pools, retrying...`);
    } catch (e) {
      log.warn(`Attempt ${attempt}/3: fetchPools failed: ${e.message}`);
    }
    if (attempt < 3) await new Promise(r => setTimeout(r, 5000));
  }
  if (pools.length === 0) log.error('WARNING: Starting with 0 pools. Alerts will not work until pools are fetched.');

  await fetchPrices();
  await fetchVolumes();
  await checkOrbitHealth();
  
  orbitWsRunning = true;
  await connectOrbitWs();
  
  heliusWsRunning = true;
  await connectHeliusWs();
  
  // Refresh intervals
  activeIntervals.push(setInterval(fetchPools, CONFIG.poolRefreshInterval));
  activeIntervals.push(setInterval(fetchPrices, CONFIG.priceRefreshInterval));
  activeIntervals.push(setInterval(fetchVolumes, CONFIG.poolRefreshInterval));
  activeIntervals.push(setInterval(checkOrbitHealth, 60000)); // Health check every minute

  // Backup polling (only runs when WebSocket is down)
  activeIntervals.push(setInterval(pollTradesBackup, CONFIG.tradesPollInterval));

  // Cache cleanup every 15 minutes to prevent memory bloat
  activeIntervals.push(setInterval(() => {
    cleanPriceCache();
    cleanTokenOverviewCache();
    cleanUserStakeCache();
    cleanBalanceCache();
    cleanSeenTxs();
    // Prune token map if it grows too large (keep pool-referenced + core tokens)
    if (tokens.size > 50000) {
      const keepMints = new Set(Object.values(MINTS));
      pools.forEach(p => { keepMints.add(p.mintX); keepMints.add(p.mintY); });
      for (const [mint] of tokens) {
        if (!keepMints.has(mint)) tokens.delete(mint);
      }
      log.info(`🧹 Pruned token map from >50k to ${tokens.size} entries`);
    }
    log.debug(`🧹 Cache cleanup: price=${priceCache.size}, tokens=${tokens.size}, users=${users.size}`);
  }, 15 * 60 * 1000));
  
  // Auto-save every 5 minutes as extra precaution
  activeIntervals.push(setInterval(() => {
    if (users.size > 0) saveUsersDebounced();
  }, 5 * 60 * 1000));

  // Auto-sync portfolios for active users every 5 minutes
  activeIntervals.push(setInterval(async () => {
    const now = Date.now();
    let synced = 0;
    
    for (const user of users.values()) {
      const hasWallets = (user.portfolioWallets?.length > 0) || user.myWallet;
      const lastSync = user.portfolio?.lastSync || 0;
      const recentlyActive = user.lastActive && (now - user.lastActive < 30 * 60 * 1000);
      
      if (hasWallets && recentlyActive && (now - lastSync > CONFIG.portfolioAutoSyncInterval)) {
        try {
          await syncPortfolio(user.chatId);
          synced++;
          await new Promise(r => setTimeout(r, 500));
        } catch (e) {
          log.debug(`Auto-sync failed for ${user.chatId}:`, e.message);
        }
      }
    }
    
    if (synced > 0) log.debug(`📊 Auto-synced ${synced} portfolios`);
  }, CONFIG.portfolioAutoSyncInterval));
  
  // ═══════════════════════════════════════════════════════════════════════════════
  // SCHEDULED JOBS (node-cron)
  // ═══════════════════════════════════════════════════════════════════════════════
  
  // Daily digest at configured time (default 9:00 AM UTC)
  const digestCron = `${CONFIG.dailyDigestMinute} ${CONFIG.dailyDigestHour} * * *`;
  activeCronJobs.push(cron.schedule(digestCron, async () => {
    log.info('📬 Sending daily digests...');
    await sendDailyDigests();
  }, { timezone: 'UTC' }));
  log.info(`📅 Daily digest scheduled for ${CONFIG.dailyDigestHour}:${String(CONFIG.dailyDigestMinute).padStart(2, '0')} UTC`);

  // Weekly stats reset (Sunday at midnight UTC)
  activeCronJobs.push(cron.schedule('0 0 * * 0', () => {
    log.info('📊 Weekly stats checkpoint');
    // Could add weekly summary feature here
  }, { timezone: 'UTC' }));

  // Database optimization (daily at 3 AM UTC) — pragma optimize only, no VACUUM in WAL mode
  activeCronJobs.push(cron.schedule('0 3 * * *', () => {
    log.info('🔧 Running database optimization...');
    try {
      if (db) {
        db.pragma('optimize');
        db.pragma('wal_checkpoint(TRUNCATE)');
        log.info('✅ Database optimized');
      }
    } catch (e) {
      log.error('Database optimization failed:', e.message);
    }
  }, { timezone: 'UTC' }));
  
  // Register commands with Telegram (shows in command menu)
  await bot.telegram.setMyCommands([
    { command: 'start', description: 'Open main menu' },
    { command: 'menu', description: 'Open main menu' },
    { command: 'portfolio', description: 'View your portfolio' },
    { command: 'pnl', description: 'Quick PnL summary' },
    { command: 'lp', description: 'View LP positions' },
    { command: 'refresh', description: 'Sync portfolio data' },
    { command: 'pools', description: 'Browse all pools' },
    { command: 'trending', description: 'Top pools by volume' },
    { command: 'newpools', description: 'Recently added pools' },
    { command: 'price', description: 'SOL & CIPHER prices' },
    { command: 'cipher', description: 'CIPHER token stats' },
    { command: 'chart', description: 'Price chart' },
    { command: 'leaderboard', description: 'Top traders PnL' },
    { command: 'liquidity', description: 'LP event history' },
    { command: 'status', description: 'Bot & API status' },
    { command: 'pause', description: 'Pause all alerts' },
    { command: 'resume', description: 'Resume alerts' },
    { command: 'snooze', description: 'Snooze for 1 hour' },
    { command: 'wallets', description: 'Manage tracked wallets' },
    { command: 'settings', description: 'Alert preferences' },
    { command: 'stats', description: 'Your usage stats' },
    { command: 'help', description: 'Show all commands' },
  ]);
  
  // ═══════════════════════════════════════════════════════════════════════════════
  // HTTP HEALTH CHECK SERVER (for Fly.io / container orchestration)
  // ═══════════════════════════════════════════════════════════════════════════════
  const HEALTH_PORT = process.env.PORT || 8080;
  healthServer = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
      const health = {
        status: 'ok',
        version: '11.0.0',
        uptime: Math.floor((Date.now() - botStartTime) / 1000),
        users: users.size,
        pools: pools.length,
        wsOrbit: orbitWs?.readyState === 1 ? 'connected' : 'disconnected',
        wsHelius: heliusWs?.readyState === 1 ? 'connected' : 'disconnected',
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(health));
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });
  
  healthServer.listen(HEALTH_PORT, '0.0.0.0', () => {
    log.info(`🏥 Health server listening on port ${HEALTH_PORT}`);
  });
  
  await bot.launch();
  
  const solPriceDisplay = getPrice(MINTS.SOL);
  const priceStr = solPriceDisplay ? `$${solPriceDisplay.toFixed(0)}` : 'N/A';
  
  console.log(`
╔════════════════════════════════════════════════════╗
║  🚀 ORBIT TRACKER v11.0 (Production)               ║
╠════════════════════════════════════════════════════╣
║  🔷 ${String(cipherPools.length).padEnd(3)} CIPHER pools                        ║
║  🌐 ${String(otherPools.length).padEnd(3)} other pools                          ║
║  👥 ${String(users.size).padEnd(3)} users                                ║
║  👛 ${String(getAllTrackedWallets().length).padEnd(3)} tracked wallets                      ║
║  💰 SOL: ${String(priceStr).padEnd(8)}                          ║
║  💾 Data: ${String(DATA_DIR.slice(-30)).padEnd(32)}║
║  ✅ Ready                                          ║
╚════════════════════════════════════════════════════╝
`);
}

// Global error handler for unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  log.error('⚠️ Unhandled Rejection:', reason);
  // Don't crash - just log and continue
});

// Global error handler for uncaught exceptions
process.on('uncaughtException', (error) => {
  log.error('❌ Uncaught Exception:', error);
  // Save user data before potential crash
  try { saveUsers(); } catch (e) {}
  // For critical errors, exit; Node.js docs recommend this
  if (error.message?.includes('FATAL') || error.code === 'ECONNREFUSED') {
    gracefulShutdown('UNCAUGHT_EXCEPTION');
  }
});

// Graceful shutdown function
async function gracefulShutdown(signal) {
  log.info(`\n🛑 Received ${signal}. Shutting down gracefully...`);

  // Force exit after 10 seconds if shutdown hangs
  const shutdownTimer = setTimeout(() => {
    log.error('Shutdown timed out after 10s, forcing exit');
    process.exit(1);
  }, 10000);
  shutdownTimer.unref();

  // Stop accepting new connections
  orbitWsRunning = false;
  heliusWsRunning = false;

  // Clear all intervals and cron jobs
  activeIntervals.forEach(id => clearInterval(id));
  activeCronJobs.forEach(job => job.stop());
  log.info(`✅ Cleared ${activeIntervals.length} intervals and ${activeCronJobs.length} cron jobs`);

  // Close health server
  if (healthServer) {
    healthServer.close();
    log.info('✅ Health server closed');
  }

  // Close WebSocket connections
  try {
    if (orbitWs && orbitWs.readyState === WebSocket.OPEN) {
      orbitWs.close();
      log.info('✅ Orbit WebSocket closed');
    }
  } catch (e) {}
  
  try {
    if (heliusWs && heliusWs.readyState === WebSocket.OPEN) {
      heliusWs.close();
      log.info('✅ Helius WebSocket closed');
    }
  } catch (e) {}
  
  // Save all pending data
  try {
    saveUsers();
    log.info('💾 User data saved');
  } catch (e) {
    log.error('Failed to save users:', e.message);
  }
  
  // Close database connection
  try {
    if (db) {
      db.close();
      log.info('✅ Database closed');
    }
  } catch (e) {
    log.error('Failed to close database:', e.message);
  }
  
  // Stop bot
  try {
    await bot.stop(signal);
    log.info('✅ Bot stopped');
  } catch (e) {}
  
  log.info('👋 Goodbye!');
  process.exit(0);
}

process.once('SIGINT', () => gracefulShutdown('SIGINT'));
process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Start the bot
start().catch(e => { 
  log.error('Fatal startup error:', e); 
  process.exit(1); 
});
