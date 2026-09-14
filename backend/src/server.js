import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import pg from "pg";
import { SignJWT, jwtVerify } from "jose";
import { createPublicClient, decodeEventLog, decodeFunctionData, getAddress, http, keccak256, toBytes, verifyMessage } from "viem";
import { z } from "zod";

const { Pool } = pg;
const env = z.object({
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  PUBLIC_APP_URL: z.string().url().default("https://lunchpad.family"),
  PUBLIC_API_URL: z.string().url().default("https://lunchbox-api-production.up.railway.app"),
  CORS_ORIGINS: z.string().default("https://lunchpad.family,https://www.lunchpad.family,https://lunchbox-web-production.up.railway.app"),
  ROBINHOOD_RPC_URL: z.string().url().default("https://rpc.mainnet.chain.robinhood.com"),
  PONS_FACTORY_ADDRESS: z.string().default("0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e"),
  CME_V6_LAUNCHPAD_ADDRESS: z.string().default("0x89a8901Faf3c6660D761F52acf531f0E27aae149"),
  CME_V6_ROUTER_ADDRESS: z.string().default("0x5354AF5139C8ba23Ee692bF9039A8e5768E66b80"),
  PROTOCOL_TREASURY: z.string().default("0x4c446aF26b08cf3BcB66A551eA7B235d1E9D200a"),
  REGISTRY_ADDRESS: z.string().optional(),
  SPLITTER_FACTORY_ADDRESS: z.string().optional(),
  AGENT_SERVICE_URL: z.string().url().optional(),
  AGENT_SERVICE_SECRET: z.string().min(32).optional()
}).parse(process.env);

const pool = new Pool({ connectionString: env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const query = (text, values=[]) => pool.query(text, values);
const jwtKey = new TextEncoder().encode(env.JWT_SECRET);
const client = createPublicClient({ transport: http(env.ROBINHOOD_RPC_URL) });
const app = Fastify({ logger: true, bodyLimit: 3_000_000, trustProxy: true });
await app.register(helmet);
await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
const origins = new Set(env.CORS_ORIGINS.split(",").map(v=>v.trim()).filter(Boolean));
await app.register(cors, { origin: (origin, cb) => cb(null, !origin || origins.has(origin) || /^https:\/\/[a-z][a-z0-9-]{2,31}\.lunchpad\.family$/.test(origin)) });

await query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS users(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),wallet_address TEXT NOT NULL UNIQUE,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),last_login_at TIMESTAMPTZ);
CREATE TABLE IF NOT EXISTS auth_nonces(wallet_address TEXT PRIMARY KEY,nonce TEXT NOT NULL,message TEXT NOT NULL,expires_at TIMESTAMPTZ NOT NULL,used_at TIMESTAMPTZ);
CREATE TABLE IF NOT EXISTS protocol_config(id SMALLINT PRIMARY KEY DEFAULT 1 CHECK(id=1),treasury_wallet TEXT NOT NULL,registry_address TEXT NOT NULL,splitter_factory_address TEXT NOT NULL,deployment_tx_hashes JSONB NOT NULL DEFAULT '[]',updated_by UUID REFERENCES users(id),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS pads(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),owner_user_id UUID NOT NULL REFERENCES users(id),owner_wallet TEXT NOT NULL,name TEXT NOT NULL,slug TEXT NOT NULL UNIQUE,niche TEXT NOT NULL,description TEXT NOT NULL,accent TEXT NOT NULL DEFAULT '#ffcc33',logo_url TEXT,custom_domain TEXT UNIQUE,namespace TEXT NOT NULL UNIQUE,registry_tx_hash TEXT,registry_token_id TEXT,status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN('draft','active','suspended')),creator_tax_bps INTEGER NOT NULL DEFAULT 200,market_type TEXT NOT NULL DEFAULT 'community',template_key TEXT NOT NULL DEFAULT 'classic',allowed_markets JSONB NOT NULL DEFAULT '[]',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS launches(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),pad_id UUID NOT NULL REFERENCES pads(id),creator_wallet TEXT NOT NULL,token_name TEXT NOT NULL,token_symbol TEXT NOT NULL,token_logo_url TEXT,token_address TEXT,curve_address TEXT,pair_token TEXT NOT NULL DEFAULT '0x0000000000000000000000000000000000000000',transaction_hash TEXT NOT NULL UNIQUE,splitter_address TEXT,launch_key TEXT,status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','live','failed','graduated')),block_number BIGINT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),verified_at TIMESTAMPTZ);
CREATE TABLE IF NOT EXISTS media_uploads(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),owner_user_id UUID NOT NULL REFERENCES users(id),mime_type TEXT NOT NULL,bytes BYTEA NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS operational_events(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),event_type TEXT NOT NULL,severity TEXT NOT NULL DEFAULT 'info',pad_id UUID REFERENCES pads(id),wallet TEXT,route TEXT,message TEXT NOT NULL,context JSONB NOT NULL DEFAULT '{}',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
ALTER TABLE pads ADD COLUMN IF NOT EXISTS ecosystem_inspiration TEXT NOT NULL DEFAULT 'robinhood-native';
ALTER TABLE launches ADD COLUMN IF NOT EXISTS market_target_key TEXT;
ALTER TABLE launches ADD COLUMN IF NOT EXISTS market_target_label TEXT;
ALTER TABLE launches ADD COLUMN IF NOT EXISTS market_target_type TEXT;
ALTER TABLE launches ADD COLUMN IF NOT EXISTS market_pair_id INTEGER;
ALTER TABLE launches ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'pons-v2';
ALTER TABLE launches ADD COLUMN IF NOT EXISTS provider_launch_id TEXT;`);

const factoryAbi = [
 {type:"function",name:"approvedPairTokens",stateMutability:"view",inputs:[{name:"pairToken",type:"address"}],outputs:[{type:"bool"}]},
 {type:"function",name:"launchToken",stateMutability:"payable",inputs:[{name:"params",type:"tuple",components:[{name:"name",type:"string"},{name:"symbol",type:"string"},{name:"logo",type:"string"},{name:"description",type:"string"},{name:"socials",type:"tuple",components:[{name:"twitter",type:"string"},{name:"telegram",type:"string"},{name:"discord",type:"string"},{name:"website",type:"string"},{name:"farcaster",type:"string"}]},{name:"creatorFeeRecipient",type:"address"},{name:"creatorTaxBps",type:"uint16"},{name:"buybackEnabled",type:"bool"},{name:"expectedEconomics",type:"bytes32"},{name:"salt",type:"bytes32"}]},{name:"launchConfigId",type:"uint256"},{name:"pairToken",type:"address"}],outputs:[{name:"token",type:"address"},{name:"curve",type:"address"}]},
 {type:"event",name:"TokenLaunched",anonymous:false,inputs:[{name:"token",type:"address",indexed:true},{name:"curve",type:"address",indexed:true},{name:"deployer",type:"address",indexed:true},{name:"pairToken",type:"address",indexed:false},{name:"launchConfigId",type:"uint256",indexed:false},{name:"graduationThreshold",type:"uint256",indexed:false}]}
];
const registryAbi=[{type:"event",name:"PadRegistered",anonymous:false,inputs:[{name:"padId",type:"bytes32",indexed:true},{name:"padOwner",type:"address",indexed:true},{name:"slug",type:"string",indexed:false},{name:"metadataURI",type:"string",indexed:false}]}];
const splitterAbi=[{type:"function",name:"creator",stateMutability:"view",inputs:[],outputs:[{type:"address"}]},{type:"function",name:"operator",stateMutability:"view",inputs:[],outputs:[{type:"address"}]},{type:"function",name:"protocol",stateMutability:"view",inputs:[],outputs:[{type:"address"}]},{type:"function",name:"pending",stateMutability:"view",inputs:[{type:"address"}],outputs:[{type:"uint256"}]}];
const splitterFactoryAbi=[{type:"function",name:"splitterForLaunch",stateMutability:"view",inputs:[{type:"bytes32"}],outputs:[{type:"address"}]}];
const cmePairAbi=[{type:"function",name:"pairCount",stateMutability:"view",inputs:[],outputs:[{type:"uint256"}]},{type:"function",name:"pair",stateMutability:"view",inputs:[{name:"pairId",type:"uint16"}],outputs:[{type:"tuple",components:[{name:"coin",type:"address"},{name:"feed",type:"address"},{name:"assetId",type:"bytes32"},{name:"router",type:"address"},{name:"enabled",type:"bool"}]}]}];
const cmeLaunchAbi=[{type:"event",name:"LaunchCreated",anonymous:false,inputs:[{name:"id",type:"uint256",indexed:true},{name:"token",type:"address",indexed:true},{name:"creator",type:"address",indexed:true},{name:"pairIds",type:"uint16[]",indexed:false},{name:"weightsBps",type:"uint16[]",indexed:false},{name:"feeBps",type:"uint16",indexed:false},{name:"openingCapQuote",type:"uint256",indexed:false},{name:"migrationCapQuote",type:"uint256",indexed:false},{name:"metadataURI",type:"string",indexed:false}]}];
const erc20Abi=[{type:"function",name:"symbol",stateMutability:"view",inputs:[],outputs:[{type:"string"}]},{type:"function",name:"name",stateMutability:"view",inputs:[],outputs:[{type:"string"}]}];
const same=(a,b)=>a.toLowerCase()===b.toLowerCase();

const stockFallback=[
 {key:"nvda",label:"NVDA",type:"stock",address:"0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC"},
 {key:"tsla",label:"TSLA",type:"stock",address:"0x322F0929c4625eD5bAd873c95208D54E1c003b2d"},
 {key:"aapl",label:"AAPL",type:"stock",address:"0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9"}
];
const cardSymbols=new Set("ETB151 ETBPRISM ETBRIVALS ETBHEROES ETBCHAOS ETBPHANTOM ETBMASQ ETBSPARKS ETBBOLT ETBFLARE ETBMEGA ETBZENITH ETBOBSIDIAN UMBREONEX MOONBREON ZARD151 ZARDOBF ZARDBASE PIKASIR MEWSIR TRMEWTWO MEGAZARDY GIRATINAV GARCHOMPSIR ZOROARKSIR MUSHU MEOWTH".split(" "));
const marketCache=new Map();

async function approvedStockTargets(){
 const cached=marketCache.get("stocks");if(cached?.expiresAt>Date.now())return cached.targets;
 const response=await fetch("https://api.robinhood.com/rhj/assets",{headers:{accept:"application/json"},signal:AbortSignal.timeout(12_000)});
 if(!response.ok)throw new Error(`Robinhood asset catalog returned ${response.status}`);
 const payload=await response.json();
 const candidates=(payload.assets||[]).flatMap(asset=>{const deployment=asset.deployments?.find(item=>item.chainId===4663);return asset.status==="ASSET_STATUS_ACTIVE"&&deployment?.contractAddress?[{asset,address:deployment.contractAddress}]:[]});
 const approved=[];for(let index=0;index<candidates.length;index+=40){const batch=candidates.slice(index,index+40);approved.push(...await Promise.all(batch.map(item=>client.readContract({address:getAddress(env.PONS_FACTORY_ADDRESS),abi:factoryAbi,functionName:"approvedPairTokens",args:[getAddress(item.address)]}).catch(()=>false))))}
 const targets=candidates.filter((_,index)=>approved[index]).map(({asset,address})=>({key:asset.tokenSymbol.toLowerCase(),label:asset.tokenSymbol,type:"stock",address:getAddress(address)})).sort((a,b)=>a.label.localeCompare(b.label));
 if(!targets.length)throw new Error("Pons returned no approved stock pairs");marketCache.set("stocks",{expiresAt:Date.now()+300_000,targets});return targets;
}

async function cmeCommodityTargets(){
 const cached=marketCache.get("commodities");if(cached?.expiresAt>Date.now())return cached.targets;
 const launchpad=getAddress(env.CME_V6_LAUNCHPAD_ADDRESS),count=Number(await client.readContract({address:launchpad,abi:cmePairAbi,functionName:"pairCount"}));
 const pairs=await Promise.all(Array.from({length:count},(_,pairId)=>pairId).map(async pairId=>{
  try{
   const pair=await client.readContract({address:launchpad,abi:cmePairAbi,functionName:"pair",args:[pairId]});if(!pair.enabled)return null;
   const[symbol,name]=await Promise.all([client.readContract({address:pair.coin,abi:erc20Abi,functionName:"symbol"}),client.readContract({address:pair.coin,abi:erc20Abi,functionName:"name"})]);
   if(cardSymbols.has(symbol.toUpperCase()))return null;
   return{key:`cme-${pairId}`,label:`${name} (${symbol})`,type:"commodity-index",address:pair.coin,pairId,unit:"index"};
  }catch{return null}
 }));
 const targets=pairs.filter(Boolean).sort((a,b)=>a.label.localeCompare(b.label));if(!targets.length)throw new Error("CME V6 returned no enabled commodity indexes");marketCache.set("commodities",{expiresAt:Date.now()+300_000,targets});return targets;
}

async function verifyCmeLaunch(hash,expected){
 const launchpad=getAddress(env.CME_V6_LAUNCHPAD_ADDRESS),router=getAddress(env.CME_V6_ROUTER_ADDRESS);
 const[receipt,transaction,pair]=await Promise.all([client.getTransactionReceipt({hash}),client.getTransaction({hash}),client.readContract({address:launchpad,abi:cmePairAbi,functionName:"pair",args:[expected.pairId]})]);
 if(receipt.status!=="success")throw new Error("CME launch transaction failed");if(!transaction.to||!same(transaction.to,router))throw new Error("Transaction did not call the verified CME V6 router");if(!pair.enabled)throw new Error("The selected CME pair is disabled");
 for(const log of receipt.logs){if(!same(log.address,launchpad))continue;try{const event=decodeEventLog({abi:cmeLaunchAbi,eventName:"LaunchCreated",data:log.data,topics:log.topics});if(!same(event.args.creator,expected.creator)||!event.args.pairIds.some(id=>Number(id)===expected.pairId))continue;return{token:event.args.token,pairToken:pair.coin,feeBps:Number(event.args.feeBps),launchId:event.args.id.toString(),blockNumber:receipt.blockNumber.toString()}}catch{}}
 throw new Error("Matching CME V6 LaunchCreated event was not found");
}

async function protocol(){
 const {rows}=await query("SELECT registry_address,splitter_factory_address,treasury_wallet FROM protocol_config WHERE id=1");
 return {chainId:4663,ponsFactory:env.PONS_FACTORY_ADDRESS,cmeV6Launchpad:env.CME_V6_LAUNCHPAD_ADDRESS,cmeV6Router:env.CME_V6_ROUTER_ADDRESS,treasuryWallet:rows[0]?.treasury_wallet||env.PROTOCOL_TREASURY,registryAddress:rows[0]?.registry_address||env.REGISTRY_ADDRESS||null,splitterFactoryAddress:rows[0]?.splitter_factory_address||env.SPLITTER_FACTORY_ADDRESS||null};
}
async function session(header){
 if(!header?.startsWith("Bearer ")) throw Object.assign(new Error("Connect and sign with your wallet"),{statusCode:401});
 const {payload}=await jwtVerify(header.slice(7),jwtKey,{issuer:"lunchpad.family",audience:"lunchbox"});
 return payload;
}
function pad(row){return {id:row.id,name:row.name,slug:row.slug,niche:row.niche,description:row.description,ownerWallet:row.owner_wallet,accent:row.accent,logoUrl:row.logo_url,status:row.status,creatorTaxBps:row.creator_tax_bps,marketType:row.market_type,templateKey:row.template_key,allowedMarkets:row.allowed_markets,ecosystemInspiration:row.ecosystem_inspiration||"robinhood-native",namespace:row.namespace,launches:Number(row.launches||0)};}

async function claimableRoutes(owner,rows){let total=0n;const routes=[];for(const row of rows){try{const amount=await client.readContract({address:getAddress(row.splitter_address),abi:splitterAbi,functionName:"pending",args:[getAddress(owner)]});total+=amount;routes.push({splitter:row.splitter_address,pendingWei:amount.toString(),tokenName:row.token_name});}catch{routes.push({splitter:row.splitter_address,pendingWei:"0",tokenName:row.token_name});}}return {total:total.toString(),routes};}
async function agentCall(path,options={}){if(!env.AGENT_SERVICE_URL||!env.AGENT_SERVICE_SECRET)throw Object.assign(new Error("Lunchbox agent kitchen is not configured"),{statusCode:503});const response=await fetch(`${env.AGENT_SERVICE_URL.replace(/\/$/,"")}${path}`,{...options,headers:{"content-type":"application/json","x-lunchbox-secret":env.AGENT_SERVICE_SECRET,...options.headers},signal:AbortSignal.timeout(35_000)});const data=await response.json();if(!response.ok)throw Object.assign(new Error(data.error||"Agent kitchen request failed"),{statusCode:response.status});return data;}

app.setErrorHandler((error,req,reply)=>{req.log.error(error);if((error.statusCode||500)>=500)query("INSERT INTO operational_events(event_type,severity,route,message,context) VALUES('api_error','critical',$1,$2,$3::jsonb)",[`${req.method} ${req.url}`,String(error.message||"Request failed").slice(0,500),JSON.stringify({requestId:req.id})]).catch(()=>{});reply.code(error.statusCode||400).send({error:error.message||"Request failed"});});
app.get("/health",async()=>({ok:true,service:"lunchbox-api",chainId:4663,factory:env.PONS_FACTORY_ADDRESS}));
app.get("/v1/config",protocol);
app.get("/v1/market-assets",async(req,reply)=>{const type=z.enum(["stocks","commodities"]).parse(req.query.type);try{const targets=type==="stocks"?await approvedStockTargets():await cmeCommodityTargets();reply.header("cache-control","public,max-age=300,stale-while-revalidate=900");return{source:type==="stocks"?"robinhood-registry+pons-v2":"cme-v6-onchain",targets}}catch(error){if(type==="stocks"){reply.header("cache-control","public,max-age=30");return{source:"verified-fallback",targets:stockFallback,warning:error.message}}throw error}});
app.get("/v1/stats",async()=>{const {rows}=await query("SELECT (SELECT COUNT(*)::int FROM pads WHERE status='active') active_pads,(SELECT COUNT(*)::int FROM launches WHERE status IN('live','graduated')) total_launches,(SELECT COUNT(DISTINCT creator_wallet)::int FROM launches WHERE status IN('live','graduated')) unique_creators,(SELECT COUNT(*)::int FROM launches WHERE status IN('live','graduated') AND created_at>=NOW()-INTERVAL '24 hours') launches_24h");return rows[0];});
app.get("/v1/auth/challenge",async req=>{
 const wallet=getAddress(z.string().parse(req.query.wallet)); const nonce=crypto.randomUUID().replaceAll("-",""); const expires=new Date(Date.now()+10*60_000);
 const message=`lunchpad.family wants you to sign in with your wallet.\n\nWallet: ${wallet}\nChain ID: 4663\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}\nExpires At: ${expires.toISOString()}`;
 await query("INSERT INTO auth_nonces(wallet_address,nonce,message,expires_at,used_at) VALUES($1,$2,$3,$4,NULL) ON CONFLICT(wallet_address) DO UPDATE SET nonce=$2,message=$3,expires_at=$4,used_at=NULL",[wallet.toLowerCase(),nonce,message,expires]);
 return {wallet,message,expiresAt:expires.toISOString()};
});
app.post("/v1/auth/verify",async req=>{
 const body=z.object({wallet:z.string(),signature:z.string()}).parse(req.body); const wallet=getAddress(body.wallet);
 const {rows}=await query("SELECT message,expires_at,used_at FROM auth_nonces WHERE wallet_address=$1",[wallet.toLowerCase()]); const n=rows[0];
 if(!n||n.used_at||new Date(n.expires_at)<new Date()) throw new Error("Sign-in challenge expired");
 if(!await verifyMessage({address:wallet,message:n.message,signature:body.signature})) throw new Error("Signature did not match this wallet");
 await query("UPDATE auth_nonces SET used_at=NOW() WHERE wallet_address=$1",[wallet.toLowerCase()]);
 const u=await query("INSERT INTO users(wallet_address,last_login_at) VALUES($1,NOW()) ON CONFLICT(wallet_address) DO UPDATE SET last_login_at=NOW() RETURNING id",[wallet.toLowerCase()]);
 const token=await new SignJWT({wallet:wallet.toLowerCase()}).setProtectedHeader({alg:"HS256"}).setSubject(u.rows[0].id).setIssuer("lunchpad.family").setAudience("lunchbox").setIssuedAt().setExpirationTime("7d").sign(jwtKey);
 return {token};
});
app.post("/v1/media",{config:{rateLimit:{max:10,timeWindow:"1 minute"}}},async req=>{
 const s=await session(req.headers.authorization); const {dataUrl}=z.object({dataUrl:z.string().max(2_100_000)}).parse(req.body); const m=/^data:(image\/(png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
 if(!m)throw new Error("Choose a PNG, JPG, WEBP or GIF image"); const bytes=Buffer.from(m[3],"base64"); if(bytes.length>1_500_000)throw new Error("Image must be smaller than 1.5 MB");
 const result=await query("INSERT INTO media_uploads(owner_user_id,mime_type,bytes) VALUES($1,$2,$3) RETURNING id",[s.sub,m[1],bytes]); return {url:`${env.PUBLIC_API_URL.replace(/\/$/,"")}/v1/media/${result.rows[0].id}`};
});
app.get("/v1/media/:id",async(req,reply)=>{const {rows}=await query("SELECT mime_type,bytes FROM media_uploads WHERE id=$1",[req.params.id]);if(!rows[0])return reply.code(404).send({error:"Image not found"});reply.header("content-type",rows[0].mime_type).header("cache-control","public,max-age=31536000,immutable").send(rows[0].bytes);});
app.get("/v1/pads",async req=>{const limit=Math.min(Number(req.query.limit)||24,100);const {rows}=await query("SELECT p.*,COUNT(l.id)::int launches FROM pads p LEFT JOIN launches l ON l.pad_id=p.id GROUP BY p.id ORDER BY p.created_at DESC LIMIT $1",[limit]);return {pads:rows.map(pad)};});
app.get("/v1/pads/availability",async req=>{const slug=z.string().regex(/^[a-z][a-z0-9-]{2,31}$/).parse(req.query.slug);const {rowCount}=await query("SELECT 1 FROM pads WHERE slug=$1",[slug]);return {slug,available:rowCount===0};});
app.get("/v1/pads/:slug",async(req,reply)=>{const p=await query("SELECT p.*,COUNT(l.id)::int launches FROM pads p LEFT JOIN launches l ON l.pad_id=p.id WHERE p.slug=$1 GROUP BY p.id",[req.params.slug]);if(!p.rows[0])return reply.code(404).send({error:"Lunchpad not found"});const l=await query("SELECT * FROM launches WHERE pad_id=$1 ORDER BY created_at DESC",[p.rows[0].id]);return {pad:pad(p.rows[0]),launches:l.rows};});
app.get("/v1/agents/:slug",async req=>agentCall(`/internal/public/${encodeURIComponent(req.params.slug)}`));
app.post("/v1/agents/:slug/chat",{config:{rateLimit:{max:20,timeWindow:"1 minute"}}},async req=>{const b=z.object({sessionId:z.string().min(8).max(100),message:z.string().min(1).max(900)}).parse(req.body);return agentCall(`/internal/public/${encodeURIComponent(req.params.slug)}/chat`,{method:"POST",body:JSON.stringify(b)});});
app.get("/v1/agent-admin/:id",async req=>{const s=await session(req.headers.authorization);const p=await query("SELECT * FROM pads WHERE id=$1 AND owner_user_id=$2",[req.params.id,s.sub]);if(!p.rows[0])throw Object.assign(new Error("Lunchpad not found or wallet is not the owner"),{statusCode:404});return agentCall(`/internal/agents/pad/${p.rows[0].id}`);});
app.get("/v1/agent-admin/:id/activity",async req=>{const s=await session(req.headers.authorization);const p=await query("SELECT id FROM pads WHERE id=$1 AND owner_user_id=$2",[req.params.id,s.sub]);if(!p.rows[0])throw Object.assign(new Error("Lunchpad not found or wallet is not the owner"),{statusCode:404});return agentCall(`/internal/agents/pad/${p.rows[0].id}/activity`);});
app.put("/v1/agent-admin/:id",async req=>{const s=await session(req.headers.authorization);const p=await query("SELECT * FROM pads WHERE id=$1 AND owner_user_id=$2",[req.params.id,s.sub]);if(!p.rows[0])throw Object.assign(new Error("Lunchpad not found or wallet is not the owner"),{statusCode:404});const b=z.object({name:z.string().min(2).max(48),personality:z.string().min(12).max(600),tone:z.enum(["funny","degen","technical","professional","friendly"]),knowledge:z.string().min(20).max(12000),rules:z.string().max(4000).default(""),welcomeMessage:z.string().min(4).max(240),status:z.enum(["active","paused"]).default("active"),socialMode:z.enum(["disabled","drafts","approved"]).default("disabled")}).parse(req.body);return agentCall("/internal/agents",{method:"POST",body:JSON.stringify({...b,padId:p.rows[0].id,padSlug:p.rows[0].slug,padName:p.rows[0].name,ownerWallet:s.wallet})});});
app.post("/v1/pads",async req=>{const s=await session(req.headers.authorization);const b=z.object({name:z.string().min(2).max(48),slug:z.string().regex(/^[a-z][a-z0-9-]{2,31}$/),niche:z.string().min(2).max(60),description:z.string().min(12).max(220),accent:z.string().regex(/^#[0-9a-fA-F]{6}$/),logoUrl:z.string().url().nullable().optional(),creatorTaxBps:z.number().int().min(200).max(400).default(200),marketType:z.enum(["community","stocks","agents","commodities","culture","memes","creators","gaming","ai"]).default("community"),templateKey:z.enum(["classic","terminal","gallery","community"]).default("classic"),allowedMarkets:z.array(z.object({key:z.string(),label:z.string(),type:z.string(),address:z.string().optional(),pairId:z.number().int().min(0).max(65535).optional(),image:z.string().url().optional(),unit:z.string().optional()})).max(100).default([]),ecosystemInspiration:z.enum(["robinhood-native","solana-inspired"]).default("robinhood-native")}).parse(req.body);if(["stocks","commodities"].includes(b.marketType)&&!b.allowedMarkets.length)throw new Error("Choose at least one market for this lunchpad");const r=await query("INSERT INTO pads(owner_user_id,owner_wallet,name,slug,niche,description,accent,logo_url,namespace,creator_tax_bps,market_type,template_key,allowed_markets,ecosystem_inspiration) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14) RETURNING *",[s.sub,s.wallet,b.name,b.slug,b.niche,b.description,b.accent,b.logoUrl||null,`lunchbox/${b.slug}/v1`,b.creatorTaxBps,b.marketType,b.templateKey,JSON.stringify(b.allowedMarkets),b.ecosystemInspiration]);return pad(r.rows[0]);});
app.post("/v1/protocol/config",async req=>{const s=await session(req.headers.authorization);if(!same(s.wallet,env.PROTOCOL_TREASURY))throw Object.assign(new Error("Only the Lunchbox treasury can configure contracts"),{statusCode:403});const b=z.object({registryAddress:z.string(),splitterFactoryAddress:z.string(),deploymentTxHashes:z.array(z.string()).min(1).max(2)}).parse(req.body);await query("INSERT INTO protocol_config(id,treasury_wallet,registry_address,splitter_factory_address,deployment_tx_hashes,updated_by) VALUES(1,$1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET registry_address=$2,splitter_factory_address=$3,deployment_tx_hashes=$4,updated_by=$5,updated_at=NOW()",[env.PROTOCOL_TREASURY,getAddress(b.registryAddress),getAddress(b.splitterFactoryAddress),JSON.stringify(b.deploymentTxHashes),s.sub]);return protocol();});
app.post("/v1/pads/:id/register",async req=>{const s=await session(req.headers.authorization);const tx=z.object({transactionHash:z.string()}).parse(req.body);const {rows}=await query("SELECT * FROM pads WHERE id=$1 AND owner_user_id=$2",[req.params.id,s.sub]);if(!rows[0])throw Object.assign(new Error("Lunchpad not found"),{statusCode:404});const cfg=await protocol();if(!cfg.registryAddress)throw new Error("Lunchbox registry is not configured");const receipt=await client.getTransactionReceipt({hash:tx.transactionHash});const wanted=keccak256(toBytes(rows[0].id));let ok=false;for(const log of receipt.logs){if(!same(log.address,cfg.registryAddress))continue;try{const e=decodeEventLog({abi:registryAbi,eventName:"PadRegistered",data:log.data,topics:log.topics});if(same(e.args.padOwner,s.wallet)&&e.args.padId===wanted&&e.args.slug===rows[0].slug)ok=true;}catch{}}if(!ok)throw new Error("Matching lunchpad registration was not found");await query("UPDATE pads SET status='active',registry_tx_hash=$2,registry_token_id=$3,updated_at=NOW() WHERE id=$1",[rows[0].id,tx.transactionHash,wanted]);return {ok:true,status:"active"};});
app.post("/v1/pads/:id/launches",async req=>{
 const s=await session(req.headers.authorization);
 const targetSchema=z.object({key:z.string(),label:z.string(),type:z.string(),address:z.string().optional(),pairId:z.number().int().min(0).max(65535).optional(),image:z.string().url().optional(),unit:z.string().optional()});
 const b=z.object({provider:z.enum(["pons-v2","cme-v6"]).default("pons-v2"),tokenName:z.string().min(1).max(48),tokenSymbol:z.string().min(1).max(12),tokenLogoUrl:z.string().url().nullable().optional(),transactionHash:z.string(),splitterAddress:z.string().optional(),launchKey:z.string().optional(),launchId:z.string().optional(),pairToken:z.string().optional(),marketTarget:targetSchema.optional()}).parse(req.body);
 const result=await query("SELECT * FROM pads WHERE id=$1 AND status='active'",[req.params.id]);const padRow=result.rows[0];if(!padRow)throw new Error("Active lunchpad not found");
 const configured=Array.isArray(padRow.allowed_markets)?padRow.allowed_markets:[];
 const marketTarget=b.marketTarget?(configured.find(item=>item.key===b.marketTarget.key)||(configured.length?null:b.marketTarget)):null;
 if(b.marketTarget&&!marketTarget)throw new Error("Selected market is not enabled for this lunchpad");
 if(["stocks","commodities"].includes(padRow.market_type)&&!marketTarget)throw new Error("Choose an enabled market for this launch");
 if(padRow.market_type==="commodities"&&b.provider!=="cme-v6")throw new Error("Commodity lunchpads launch through CME V6");
 if(b.provider==="cme-v6"){
  if(padRow.market_type!=="commodities"||!Number.isInteger(marketTarget?.pairId))throw new Error("CME V6 requires a configured commodity pair");
  const launch=await verifyCmeLaunch(b.transactionHash,{creator:getAddress(s.wallet),pairId:marketTarget.pairId});
  if(marketTarget.address&&!same(marketTarget.address,launch.pairToken))throw new Error("CME launch used a different commodity pair");
  const inserted=await query("INSERT INTO launches(pad_id,creator_wallet,token_name,token_symbol,token_logo_url,token_address,curve_address,pair_token,transaction_hash,splitter_address,launch_key,status,block_number,market_target_key,market_target_label,market_target_type,market_pair_id,provider,provider_launch_id,verified_at) VALUES($1,$2,$3,$4,$5,$6,NULL,$7,$8,NULL,NULL,'live',$9,$10,$11,$12,$13,'cme-v6',$14,NOW()) RETURNING *",[padRow.id,s.wallet,b.tokenName,b.tokenSymbol,b.tokenLogoUrl||null,launch.token,launch.pairToken,b.transactionHash,launch.blockNumber,marketTarget.key,marketTarget.label,marketTarget.type,marketTarget.pairId,launch.launchId]);
  agentCall(`/internal/agents/pad/${padRow.id}/facts`,{method:"POST",body:JSON.stringify({type:"verified_token_launch",label:`${b.tokenName} ($${b.tokenSymbol})`,value:launch.token,context:{provider:"cme-v6",transactionHash:b.transactionHash,creatorWallet:s.wallet,marketTarget}})}).catch(()=>{});return inserted.rows[0];
 }
 if(!b.splitterAddress||!b.launchKey)throw new Error("Pons launches require a verified fee route");
 const cfg=await protocol();if(!cfg.splitterFactoryAddress)throw new Error("Fee splitter factory is not configured");
 const[receipt,transaction]=await Promise.all([client.getTransactionReceipt({hash:b.transactionHash}),client.getTransaction({hash:b.transactionHash})]);
 if(receipt.status!=="success"||!transaction.to||!same(transaction.to,env.PONS_FACTORY_ADDRESS))throw new Error("Transaction is not a successful Pons launch");
 const call=decodeFunctionData({abi:factoryAbi,data:transaction.input});if(call.functionName!=="launchToken")throw new Error("Transaction is not a Pons launch");const params=call.args[0];
 if(!same(params.creatorFeeRecipient,b.splitterAddress)||Number(params.creatorTaxBps)!==Number(padRow.creator_tax_bps))throw new Error("Launch fees do not match this lunchpad");
 const[creator,operator,protocolWallet,registered]=await Promise.all([client.readContract({address:getAddress(b.splitterAddress),abi:splitterAbi,functionName:"creator"}),client.readContract({address:getAddress(b.splitterAddress),abi:splitterAbi,functionName:"operator"}),client.readContract({address:getAddress(b.splitterAddress),abi:splitterAbi,functionName:"protocol"}),client.readContract({address:getAddress(cfg.splitterFactoryAddress),abi:splitterFactoryAbi,functionName:"splitterForLaunch",args:[b.launchKey]})]);
 if(!same(creator,s.wallet)||!same(operator,padRow.owner_wallet)||!same(protocolWallet,cfg.treasuryWallet)||!same(registered,b.splitterAddress))throw new Error("Fee splitter verification failed");
 let launch=null;for(const log of receipt.logs){if(!same(log.address,env.PONS_FACTORY_ADDRESS))continue;try{const event=decodeEventLog({abi:factoryAbi,eventName:"TokenLaunched",data:log.data,topics:log.topics});launch=event.args;break}catch{}}
 if(!launch)throw new Error("Pons launch event not found");if(padRow.market_type==="stocks"&&(!marketTarget.address||!same(launch.pairToken,marketTarget.address)))throw new Error("Pons launch used a different stock pair");
 const inserted=await query("INSERT INTO launches(pad_id,creator_wallet,token_name,token_symbol,token_logo_url,token_address,curve_address,pair_token,transaction_hash,splitter_address,launch_key,status,block_number,market_target_key,market_target_label,market_target_type,market_pair_id,provider,verified_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'live',$12,$13,$14,$15,$16,'pons-v2',NOW()) RETURNING *",[padRow.id,s.wallet,b.tokenName,b.tokenSymbol,b.tokenLogoUrl||null,launch.token,launch.curve,launch.pairToken,b.transactionHash,b.splitterAddress,b.launchKey,receipt.blockNumber.toString(),marketTarget?.key||null,marketTarget?.label||null,marketTarget?.type||null,marketTarget?.pairId??null]);
 agentCall(`/internal/agents/pad/${padRow.id}/facts`,{method:"POST",body:JSON.stringify({type:"verified_token_launch",label:`${b.tokenName} ($${b.tokenSymbol})`,value:launch.token,context:{provider:"pons-v2",transactionHash:b.transactionHash,curveAddress:launch.curve,creatorWallet:s.wallet,marketTarget}})}).catch(()=>{});return inserted.rows[0];
});

app.patch("/v1/pads/:id",async req=>{const s=await session(req.headers.authorization);const b=z.object({description:z.string().min(12).max(220).optional(),accent:z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),logoUrl:z.string().url().nullable().optional(),creatorTaxBps:z.number().int().min(200).max(400).optional()}).parse(req.body);const current=await query("SELECT * FROM pads WHERE id=$1 AND owner_user_id=$2",[req.params.id,s.sub]);if(!current.rows[0])throw Object.assign(new Error("Lunchpad not found or wallet is not the owner"),{statusCode:404});const p=current.rows[0];const r=await query("UPDATE pads SET description=$1,accent=$2,logo_url=$3,creator_tax_bps=$4,updated_at=NOW() WHERE id=$5 RETURNING *",[b.description??p.description,b.accent??p.accent,b.logoUrl===undefined?p.logo_url:b.logoUrl,b.creatorTaxBps??p.creator_tax_bps,p.id]);return pad(r.rows[0]);});

app.post("/v1/pads/:id/launch-failures",async req=>{const s=await session(req.headers.authorization);const b=z.object({stage:z.string().max(40),message:z.string().min(1).max(500),tokenName:z.string().max(48).optional(),tokenSymbol:z.string().max(12).optional()}).parse(req.body);await query("INSERT INTO operational_events(event_type,severity,pad_id,wallet,route,message,context) SELECT 'launch_failed','warning',id,$2,$3,$4,$5::jsonb FROM pads WHERE id=$1",[req.params.id,s.wallet,`launch:${b.stage}`,b.message,JSON.stringify({tokenName:b.tokenName||null,tokenSymbol:b.tokenSymbol||null})]);return {ok:true};});

app.get("/v1/pads/:id/analytics",async req=>{const s=await session(req.headers.authorization);const p=await query("SELECT * FROM pads WHERE id=$1",[req.params.id]);if(!p.rows[0])throw Object.assign(new Error("Lunchpad not found"),{statusCode:404});const owner=p.rows[0].owner_user_id===s.sub,admin=same(s.wallet,env.PROTOCOL_TREASURY);if(!owner&&!admin)throw Object.assign(new Error("Owner or treasury wallet required"),{statusCode:403});const [stats,windows,targets,recent,incidents,routes]=await Promise.all([query("SELECT COUNT(*)::int launches,COUNT(DISTINCT creator_wallet)::int creators,MIN(created_at)::text first_launch_at,MAX(created_at)::text last_launch_at FROM launches WHERE pad_id=$1 AND status IN('live','graduated')",[req.params.id]),query("SELECT COUNT(*) FILTER(WHERE created_at>=NOW()-INTERVAL '24 hours')::int launches_24h,COUNT(*) FILTER(WHERE created_at>=NOW()-INTERVAL '7 days')::int launches_7d,COUNT(*) FILTER(WHERE created_at>=NOW()-INTERVAL '30 days')::int launches_30d FROM launches WHERE pad_id=$1 AND status IN('live','graduated')",[req.params.id]),query("SELECT COALESCE(market_target_label,'General') label,COUNT(*)::int count FROM launches WHERE pad_id=$1 GROUP BY 1 ORDER BY count DESC",[req.params.id]),query("SELECT * FROM launches WHERE pad_id=$1 ORDER BY created_at DESC LIMIT 10",[req.params.id]),query("SELECT * FROM operational_events WHERE pad_id=$1 AND created_at>=NOW()-INTERVAL '30 days' ORDER BY created_at DESC LIMIT 20",[req.params.id]),query("SELECT DISTINCT ON(splitter_address) splitter_address,token_name FROM launches WHERE pad_id=$1 AND splitter_address IS NOT NULL ORDER BY splitter_address,created_at DESC LIMIT 100",[req.params.id])]);const amounts=await claimableRoutes(p.rows[0].owner_wallet,routes.rows);return {...stats.rows[0],...windows.rows[0],access_role:owner?"owner":"protocol_admin",market_distribution:targets.rows,recent_launches:recent.rows,incidents:incidents.rows,claimable_operator_wei:amounts.total,claimable_routes:amounts.routes};});

app.get("/v1/protocol/analytics",async req=>{const s=await session(req.headers.authorization);if(!same(s.wallet,env.PROTOCOL_TREASURY))throw Object.assign(new Error("Treasury wallet required"),{statusCode:403});const [summary,pads,events]=await Promise.all([query("SELECT (SELECT COUNT(*)::int FROM pads WHERE status='active') total_pads,(SELECT COUNT(*)::int FROM launches WHERE status IN('live','graduated')) total_launches,(SELECT COUNT(DISTINCT creator_wallet)::int FROM launches WHERE status IN('live','graduated')) unique_creators,(SELECT COUNT(*)::int FROM launches WHERE created_at>=NOW()-INTERVAL '24 hours') launches_24h,(SELECT COUNT(*)::int FROM operational_events WHERE event_type='launch_failed' AND created_at>=NOW()-INTERVAL '30 days') failed_launches_30d"),query("SELECT p.id,p.name,p.slug,p.owner_wallet,p.market_type,p.creator_tax_bps,p.logo_url,COUNT(DISTINCT l.id)::int launches,COUNT(DISTINCT l.creator_wallet)::int creators,MAX(l.created_at)::text last_launch_at FROM pads p LEFT JOIN launches l ON l.pad_id=p.id WHERE p.status='active' GROUP BY p.id ORDER BY launches DESC,p.created_at DESC LIMIT 100"),query("SELECT * FROM operational_events ORDER BY created_at DESC LIMIT 30")]);return {...summary.rows[0],pads:pads.rows,events:events.rows};});

app.get("/v1/protocol/monitoring",async req=>{const s=await session(req.headers.authorization);if(!same(s.wallet,env.PROTOCOL_TREASURY))throw Object.assign(new Error("Treasury wallet required"),{statusCode:403});const [balance,counts,events]=await Promise.all([client.getBalance({address:getAddress(env.PROTOCOL_TREASURY)}),query("SELECT COUNT(*) FILTER(WHERE event_type='launch_failed' AND created_at>=NOW()-INTERVAL '24 hours')::int launch_failures_24h,COUNT(*) FILTER(WHERE event_type='api_error' AND created_at>=NOW()-INTERVAL '24 hours')::int api_errors_24h FROM operational_events"),query("SELECT * FROM operational_events ORDER BY created_at DESC LIMIT 50")]);return {treasury_balance_wei:balance.toString(),...counts.rows[0],events:events.rows};});

await app.listen({port:env.PORT,host:"0.0.0.0"});
