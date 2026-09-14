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
  CORS_ORIGINS: z.string().default("https://lunchpad.family,https://www.lunchpad.family"),
  ROBINHOOD_RPC_URL: z.string().url().default("https://rpc.mainnet.chain.robinhood.com"),
  PONS_FACTORY_ADDRESS: z.string().default("0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e"),
  PROTOCOL_TREASURY: z.string().default("0x4c446aF26b08cf3BcB66A551eA7B235d1E9D200a"),
  REGISTRY_ADDRESS: z.string().optional(),
  SPLITTER_FACTORY_ADDRESS: z.string().optional()
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
CREATE TABLE IF NOT EXISTS media_uploads(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),owner_user_id UUID NOT NULL REFERENCES users(id),mime_type TEXT NOT NULL,bytes BYTEA NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`);

const factoryAbi = [
 {type:"function",name:"launchToken",stateMutability:"payable",inputs:[{name:"params",type:"tuple",components:[{name:"name",type:"string"},{name:"symbol",type:"string"},{name:"logo",type:"string"},{name:"description",type:"string"},{name:"socials",type:"tuple",components:[{name:"twitter",type:"string"},{name:"telegram",type:"string"},{name:"discord",type:"string"},{name:"website",type:"string"},{name:"farcaster",type:"string"}]},{name:"creatorFeeRecipient",type:"address"},{name:"creatorTaxBps",type:"uint16"},{name:"buybackEnabled",type:"bool"},{name:"expectedEconomics",type:"bytes32"},{name:"salt",type:"bytes32"}]},{name:"launchConfigId",type:"uint256"},{name:"pairToken",type:"address"}],outputs:[{name:"token",type:"address"},{name:"curve",type:"address"}]},
 {type:"event",name:"TokenLaunched",anonymous:false,inputs:[{name:"token",type:"address",indexed:true},{name:"curve",type:"address",indexed:true},{name:"deployer",type:"address",indexed:true},{name:"pairToken",type:"address",indexed:false},{name:"launchConfigId",type:"uint256",indexed:false},{name:"graduationThreshold",type:"uint256",indexed:false}]}
];
const registryAbi=[{type:"event",name:"PadRegistered",anonymous:false,inputs:[{name:"padId",type:"bytes32",indexed:true},{name:"padOwner",type:"address",indexed:true},{name:"slug",type:"string",indexed:false},{name:"metadataURI",type:"string",indexed:false}]}];
const splitterAbi=[{type:"function",name:"creator",stateMutability:"view",inputs:[],outputs:[{type:"address"}]},{type:"function",name:"operator",stateMutability:"view",inputs:[],outputs:[{type:"address"}]},{type:"function",name:"protocol",stateMutability:"view",inputs:[],outputs:[{type:"address"}]}];
const splitterFactoryAbi=[{type:"function",name:"splitterForLaunch",stateMutability:"view",inputs:[{type:"bytes32"}],outputs:[{type:"address"}]}];
const same=(a,b)=>a.toLowerCase()===b.toLowerCase();

async function protocol(){
 const {rows}=await query("SELECT registry_address,splitter_factory_address,treasury_wallet FROM protocol_config WHERE id=1");
 return {chainId:4663,ponsFactory:env.PONS_FACTORY_ADDRESS,treasuryWallet:rows[0]?.treasury_wallet||env.PROTOCOL_TREASURY,registryAddress:rows[0]?.registry_address||env.REGISTRY_ADDRESS||null,splitterFactoryAddress:rows[0]?.splitter_factory_address||env.SPLITTER_FACTORY_ADDRESS||null};
}
async function session(header){
 if(!header?.startsWith("Bearer ")) throw Object.assign(new Error("Connect and sign with your wallet"),{statusCode:401});
 const {payload}=await jwtVerify(header.slice(7),jwtKey,{issuer:"lunchpad.family",audience:"lunchbox"});
 return payload;
}
function pad(row){return {id:row.id,name:row.name,slug:row.slug,niche:row.niche,description:row.description,ownerWallet:row.owner_wallet,accent:row.accent,logoUrl:row.logo_url,status:row.status,creatorTaxBps:row.creator_tax_bps,marketType:row.market_type,templateKey:row.template_key,allowedMarkets:row.allowed_markets,launches:Number(row.launches||0)};}

app.setErrorHandler((error,req,reply)=>{req.log.error(error);reply.code(error.statusCode||400).send({error:error.message||"Request failed"});});
app.get("/health",async()=>({ok:true,service:"lunchbox-api",chainId:4663,factory:env.PONS_FACTORY_ADDRESS}));
app.get("/v1/config",protocol);
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
 const result=await query("INSERT INTO media_uploads(owner_user_id,mime_type,bytes) VALUES($1,$2,$3) RETURNING id",[s.sub,m[1],bytes]); return {url:`https://api.lunchpad.family/v1/media/${result.rows[0].id}`};
});
app.get("/v1/media/:id",async(req,reply)=>{const {rows}=await query("SELECT mime_type,bytes FROM media_uploads WHERE id=$1",[req.params.id]);if(!rows[0])return reply.code(404).send({error:"Image not found"});reply.header("content-type",rows[0].mime_type).header("cache-control","public,max-age=31536000,immutable").send(rows[0].bytes);});
app.get("/v1/pads",async req=>{const limit=Math.min(Number(req.query.limit)||24,100);const {rows}=await query("SELECT p.*,COUNT(l.id)::int launches FROM pads p LEFT JOIN launches l ON l.pad_id=p.id GROUP BY p.id ORDER BY p.created_at DESC LIMIT $1",[limit]);return {pads:rows.map(pad)};});
app.get("/v1/pads/availability",async req=>{const slug=z.string().regex(/^[a-z][a-z0-9-]{2,31}$/).parse(req.query.slug);const {rowCount}=await query("SELECT 1 FROM pads WHERE slug=$1",[slug]);return {slug,available:rowCount===0};});
app.get("/v1/pads/:slug",async(req,reply)=>{const p=await query("SELECT p.*,COUNT(l.id)::int launches FROM pads p LEFT JOIN launches l ON l.pad_id=p.id WHERE p.slug=$1 GROUP BY p.id",[req.params.slug]);if(!p.rows[0])return reply.code(404).send({error:"Lunchpad not found"});const l=await query("SELECT * FROM launches WHERE pad_id=$1 ORDER BY created_at DESC",[p.rows[0].id]);return {pad:pad(p.rows[0]),launches:l.rows};});
app.post("/v1/pads",async req=>{const s=await session(req.headers.authorization);const b=z.object({name:z.string().min(2).max(48),slug:z.string().regex(/^[a-z][a-z0-9-]{2,31}$/),niche:z.string().min(2).max(60),description:z.string().min(12).max(220),accent:z.string().regex(/^#[0-9a-fA-F]{6}$/),logoUrl:z.string().url().nullable().optional(),creatorTaxBps:z.number().int().min(200).max(400).default(200),marketType:z.string().default("community"),templateKey:z.string().default("classic")}).parse(req.body);const r=await query("INSERT INTO pads(owner_user_id,owner_wallet,name,slug,niche,description,accent,logo_url,namespace,creator_tax_bps,market_type,template_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *",[s.sub,s.wallet,b.name,b.slug,b.niche,b.description,b.accent,b.logoUrl||null,`lunchbox/${b.slug}/v1`,b.creatorTaxBps,b.marketType,b.templateKey]);return pad(r.rows[0]);});
app.post("/v1/protocol/config",async req=>{const s=await session(req.headers.authorization);if(!same(s.wallet,env.PROTOCOL_TREASURY))throw Object.assign(new Error("Only the Lunchbox treasury can configure contracts"),{statusCode:403});const b=z.object({registryAddress:z.string(),splitterFactoryAddress:z.string(),deploymentTxHashes:z.array(z.string()).min(1).max(2)}).parse(req.body);await query("INSERT INTO protocol_config(id,treasury_wallet,registry_address,splitter_factory_address,deployment_tx_hashes,updated_by) VALUES(1,$1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET registry_address=$2,splitter_factory_address=$3,deployment_tx_hashes=$4,updated_by=$5,updated_at=NOW()",[env.PROTOCOL_TREASURY,getAddress(b.registryAddress),getAddress(b.splitterFactoryAddress),JSON.stringify(b.deploymentTxHashes),s.sub]);return protocol();});
app.post("/v1/pads/:id/register",async req=>{const s=await session(req.headers.authorization);const tx=z.object({transactionHash:z.string()}).parse(req.body);const {rows}=await query("SELECT * FROM pads WHERE id=$1 AND owner_user_id=$2",[req.params.id,s.sub]);if(!rows[0])throw Object.assign(new Error("Lunchpad not found"),{statusCode:404});const cfg=await protocol();if(!cfg.registryAddress)throw new Error("Lunchbox registry is not configured");const receipt=await client.getTransactionReceipt({hash:tx.transactionHash});const wanted=keccak256(toBytes(rows[0].id));let ok=false;for(const log of receipt.logs){if(!same(log.address,cfg.registryAddress))continue;try{const e=decodeEventLog({abi:registryAbi,eventName:"PadRegistered",data:log.data,topics:log.topics});if(same(e.args.padOwner,s.wallet)&&e.args.padId===wanted&&e.args.slug===rows[0].slug)ok=true;}catch{}}if(!ok)throw new Error("Matching lunchpad registration was not found");await query("UPDATE pads SET status='active',registry_tx_hash=$2,registry_token_id=$3,updated_at=NOW() WHERE id=$1",[rows[0].id,tx.transactionHash,wanted]);return {ok:true,status:"active"};});
app.post("/v1/pads/:id/launches",async req=>{const s=await session(req.headers.authorization);const b=z.object({tokenName:z.string().min(1).max(48),tokenSymbol:z.string().min(1).max(12),tokenLogoUrl:z.string().url().nullable().optional(),transactionHash:z.string(),splitterAddress:z.string(),launchKey:z.string(),pairToken:z.string().optional()}).parse(req.body);const p=await query("SELECT * FROM pads WHERE id=$1 AND status='active'",[req.params.id]);if(!p.rows[0])throw new Error("Active lunchpad not found");const cfg=await protocol();if(!cfg.splitterFactoryAddress)throw new Error("Fee splitter factory is not configured");const receipt=await client.getTransactionReceipt({hash:b.transactionHash});const transaction=await client.getTransaction({hash:b.transactionHash});if(receipt.status!=="success"||!transaction.to||!same(transaction.to,env.PONS_FACTORY_ADDRESS))throw new Error("Transaction is not a successful Pons launch");const call=decodeFunctionData({abi:factoryAbi,data:transaction.input});const params=call.args[0];if(!same(params.creatorFeeRecipient,b.splitterAddress)||Number(params.creatorTaxBps)!==Number(p.rows[0].creator_tax_bps))throw new Error("Launch fees do not match this lunchpad");const [creator,operator,protocolWallet,registered]=await Promise.all([client.readContract({address:getAddress(b.splitterAddress),abi:splitterAbi,functionName:"creator"}),client.readContract({address:getAddress(b.splitterAddress),abi:splitterAbi,functionName:"operator"}),client.readContract({address:getAddress(b.splitterAddress),abi:splitterAbi,functionName:"protocol"}),client.readContract({address:getAddress(cfg.splitterFactoryAddress),abi:splitterFactoryAbi,functionName:"splitterForLaunch",args:[b.launchKey]})]);if(!same(creator,s.wallet)||!same(operator,p.rows[0].owner_wallet)||!same(protocolWallet,cfg.treasuryWallet)||!same(registered,b.splitterAddress))throw new Error("Fee splitter verification failed");let launch=null;for(const log of receipt.logs){if(!same(log.address,env.PONS_FACTORY_ADDRESS))continue;try{const e=decodeEventLog({abi:factoryAbi,eventName:"TokenLaunched",data:log.data,topics:log.topics});launch=e.args;break}catch{}}if(!launch)throw new Error("Pons launch event not found");const r=await query("INSERT INTO launches(pad_id,creator_wallet,token_name,token_symbol,token_logo_url,token_address,curve_address,pair_token,transaction_hash,splitter_address,launch_key,status,block_number,verified_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'live',$12,NOW()) RETURNING *",[p.rows[0].id,s.wallet,b.tokenName,b.tokenSymbol,b.tokenLogoUrl||null,launch.token,launch.curve,launch.pairToken,b.transactionHash,b.splitterAddress,b.launchKey,receipt.blockNumber.toString()]);return r.rows[0];});

await app.listen({port:env.PORT,host:"0.0.0.0"});
