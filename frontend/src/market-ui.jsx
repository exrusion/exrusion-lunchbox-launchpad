import React,{useEffect,useState}from"react";
import{Bot,Database,RefreshCw}from"lucide-react";
import{createPublicClient,createWalletClient,custom,decodeEventLog,http,parseEther}from"viem";
import{ensureRobinhoodChain}from"./wallets";

const API=import.meta.env.VITE_API_URL||"https://lunchbox-api-production.up.railway.app";
export const CME_V6_LAUNCHPAD="0x89a8901Faf3c6660D761F52acf531f0E27aae149";
export const CME_V6_ROUTER="0x5354AF5139C8ba23Ee692bF9039A8e5768E66b80";

export const MARKET_OPTIONS=[
 {value:"community",label:"Community"},
 {value:"stocks",label:"Stocks"},
 {value:"agents",label:"AI agents"},
 {value:"commodities",label:"CME Commodities"},
 {value:"culture",label:"Culture"},
 {value:"memes",label:"Memes"},
 {value:"creators",label:"Creators"},
 {value:"gaming",label:"Gaming"},
];

export function marketPreset(marketType){
 const item=MARKET_OPTIONS.find(x=>x.value===marketType)||MARKET_OPTIONS[0];
 return {marketType:item.value,niche:item.label,templateKey:["stocks","commodities"].includes(item.value)?"terminal":item.value==="culture"?"gallery":"classic",allowedMarkets:[]};
}

async function getTargets(type){
 if(!["stocks","commodities"].includes(type))return[];
 const response=await fetch(`${API}/v1/market-assets?type=${type}`);
 const body=await response.json().catch(()=>({}));
 if(!response.ok)throw new Error(body.error||"Could not open the market pantry");
 return body.targets||[];
}

export function useMarketTargets(type){
 const[targets,setTargets]=useState([]),[loading,setLoading]=useState(false),[warning,setWarning]=useState("");
 useEffect(()=>{let live=true;if(!["stocks","commodities"].includes(type)){setTargets([]);setWarning("");return()=>{live=false}}setLoading(true);setWarning("");getTargets(type).then(items=>{if(live)setTargets(items)}).catch(error=>{if(live)setWarning(error.message)}).finally(()=>{if(live)setLoading(false)});return()=>{live=false}},[type]);
 return {targets,loading,warning};
}

export function MarketConfigurator({form,setForm}){
 const{targets,loading,warning}=useMarketTargets(form.marketType);
 useEffect(()=>{if(!targets.length||form.allowedMarkets?.length)return;setForm(current=>current.marketType===form.marketType&&!current.allowedMarkets?.length?{...current,allowedMarkets:targets}:current)},[targets,form.marketType,form.allowedMarkets?.length,setForm]);
 const selected=new Set((form.allowedMarkets||[]).map(x=>x.key));
 const toggle=target=>setForm(current=>({...current,allowedMarkets:selected.has(target.key)?current.allowedMarkets.filter(x=>x.key!==target.key):[...current.allowedMarkets,target]}));
 const provider=form.marketType==="commodities"?"Commodity Market Exchange V6":form.marketType==="agents"?"AI17Z + Pons V2":"Pons V2";
 const providerCopy=form.marketType==="commodities"?"Direct CME V6 launches against a selected onchain commodity index.":form.marketType==="stocks"?`${targets.length||"Live"} approved Robinhood stock pairs available to creators.`:form.marketType==="agents"?"Every launchpad gets an isolated, owner-controlled AI17Z personality powered by your configured model API.":"Wallet-signed token launches on Robinhood Chain.";
 return <>
  <div className="providerPanel"><Database/><div><small>EXECUTION PROVIDER</small><b>{provider}</b><span>{providerCopy}</span></div></div>
  {["stocks","commodities"].includes(form.marketType)&&<fieldset className="marketPicker"><legend>{form.marketType==="stocks"?`Pons stock pairs creators can select (${targets.length} live)`:"CME commodity indexes creators can select"}</legend>{loading&&<div className="marketLoading"><RefreshCw/> Loading live markets…</div>}{warning&&<div className="notice">{warning}</div>}<div className="marketChips">{targets.map(target=><button type="button" className={selected.has(target.key)?"selected":""} onClick={()=>toggle(target)} key={target.key}>{target.label}</button>)}</div>{!loading&&targets.length>0&&<small>{selected.size} selected · click a market to include or exclude it</small>}</fieldset>}
  {form.marketType==="agents"&&<fieldset className="agentPreset"><legend><Bot/> AI agent included</legend><div className="two"><label>Agent name<input required minLength="2" maxLength="48" value={form.agentName} onChange={e=>setForm({...form,agentName:e.target.value})}/></label><label>Voice<select value={form.agentTone} onChange={e=>setForm({...form,agentTone:e.target.value})}><option value="funny">Funny</option><option value="degen">Degen</option><option value="technical">Technical</option><option value="professional">Professional</option><option value="friendly">Friendly</option></select></label></div><label>Agent personality<textarea required minLength="12" maxLength="600" value={form.agentPersonality} onChange={e=>setForm({...form,agentPersonality:e.target.value})}/></label><small>The agent is created with isolated memory and can only use owner-approved facts plus verified launches.</small></fieldset>}
 </>;
}

export function PadBuilderForm({form,setForm,onSubmit,busy}){
 const setMarket=marketType=>setForm(current=>({...current,...marketPreset(marketType),agentName:current.agentName||`${current.name||"My"} Lunchmate`}));
 return <form onSubmit={onSubmit}>
  <div className="two"><label>Launchpad name<input required minLength="2" maxLength="48" value={form.name} onChange={e=>{const name=e.target.value;setForm({...form,name,slug:name.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,32)})}}/></label><label>Storefront address<input required pattern="[a-z][a-z0-9-]{2,31}" value={form.slug} onChange={e=>setForm({...form,slug:e.target.value})}/><small>{form.slug||"your-pad"}.lunchpad.family</small></label></div>
  <div className="two"><label>Market type<select value={form.marketType} onChange={e=>setMarket(e.target.value)}>{MARKET_OPTIONS.map(item=><option value={item.value} key={item.value}>{item.label}</option>)}</select></label><label>Pad template<select value={form.templateKey} onChange={e=>setForm({...form,templateKey:e.target.value})}><option value="classic">Classic tray</option><option value="terminal">Market terminal</option><option value="gallery">Gallery box</option><option value="community">Picnic table</option></select></label></div>
  <div className="two"><label>Market label<input required minLength="2" maxLength="60" value={form.niche} onChange={e=>setForm({...form,niche:e.target.value})}/></label><label>Product model<select value={form.ecosystemInspiration} onChange={e=>setForm({...form,ecosystemInspiration:e.target.value})}><option value="robinhood-native">Robinhood-native</option><option value="solana-inspired">Solana-inspired mechanics</option></select></label></div>
  <MarketConfigurator form={form} setForm={setForm}/>
  <label>Public description<textarea required minLength="12" maxLength="220" value={form.description} onChange={e=>setForm({...form,description:e.target.value})}/></label>
  <label>Lunchpad image <small>optional · PNG, JPG, WEBP or GIF · max 1.5 MB</small><input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={e=>setForm({...form,image:e.target.files?.[0]||null})}/></label>
  <div className="two"><label>Accent color<input type="color" value={form.accent} onChange={e=>setForm({...form,accent:e.target.value})}/></label><label>Creator tax<select value={form.creatorTaxBps} onChange={e=>setForm({...form,creatorTaxBps:Number(e.target.value)})}><option value="200">2% · lower friction</option><option value="300">3% · balanced</option><option value="400">4% · more revenue</option></select></label></div>
  <div className="feePreview"><b>{form.creatorTaxBps/100}% tax</b> → 70% launcher · 20% owner · 10% Lunchbox</div>
  <button className="primary" disabled={!!busy}>{busy||"Sign & deploy"}</button>
 </form>;
}

const launchParams=[{name:"name",type:"string"},{name:"symbol",type:"string"},{name:"metadataURI",type:"string"},{name:"pairIds",type:"uint16[]"},{name:"weightsBps",type:"uint16[]"},{name:"feeBps",type:"uint16"},{name:"devLeg",type:"uint8"},{name:"minTokensOut",type:"uint256"},{name:"deadline",type:"uint256"}];
const cmeRouterAbi=[{type:"function",name:"createLaunchWithETH",stateMutability:"payable",inputs:[{name:"p",type:"tuple",components:launchParams}],outputs:[{name:"id",type:"uint256"},{name:"token",type:"address"},{name:"tokensOut",type:"uint256"}]}];
const cmeLaunchpadAbi=[{type:"event",name:"LaunchCreated",anonymous:false,inputs:[{name:"id",type:"uint256",indexed:true},{name:"token",type:"address",indexed:true},{name:"creator",type:"address",indexed:true},{name:"pairIds",type:"uint16[]",indexed:false},{name:"weightsBps",type:"uint16[]",indexed:false},{name:"feeBps",type:"uint16",indexed:false},{name:"openingCapQuote",type:"uint256",indexed:false},{name:"migrationCapQuote",type:"uint256",indexed:false},{name:"metadataURI",type:"string",indexed:false}]}];

function metadataUri(input){return `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify({name:input.name,symbol:input.symbol,description:input.description,image:input.image,external_url:input.website,provider:"Commodity Market Exchange V6",attributes:[{trait_type:"Launchpad",value:"Lunchbox"}]}))}`}

export async function launchCmeToken({account,provider,chain,input}){
 await ensureRobinhoodChain(provider);
 const publicClient=createPublicClient({chain,transport:http("https://rpc.mainnet.chain.robinhood.com")});
 const walletClient=createWalletClient({account,chain,transport:custom(provider)});
 const value=parseEther(input.firstBuyEth);
 const base={name:input.name,symbol:input.symbol,metadataURI:metadataUri(input),pairIds:[input.pairId],weightsBps:[10000],feeBps:input.feeBps,devLeg:0,minTokensOut:0n,deadline:BigInt(Math.floor(Date.now()/1000)+1200)};
 const simulation=await publicClient.simulateContract({account,address:CME_V6_ROUTER,abi:cmeRouterAbi,functionName:"createLaunchWithETH",args:[base],value});
 const params={...base,minTokensOut:simulation.result[2]*97n/100n};
 const hash=await walletClient.writeContract({address:CME_V6_ROUTER,abi:cmeRouterAbi,functionName:"createLaunchWithETH",args:[params],value});
 const receipt=await publicClient.waitForTransactionReceipt({hash,confirmations:1,timeout:180000});
 if(receipt.status!=="success")throw new Error("The CME V6 launch transaction reverted.");
 for(const log of receipt.logs){if(log.address.toLowerCase()!==CME_V6_LAUNCHPAD.toLowerCase())continue;try{const event=decodeEventLog({abi:cmeLaunchpadAbi,eventName:"LaunchCreated",data:log.data,topics:log.topics});if(event.args.creator.toLowerCase()===account.toLowerCase())return{hash,token:event.args.token,id:event.args.id.toString()}}catch{}}
 throw new Error("Launch confirmed, but CME V6 did not emit a matching LaunchCreated event.");
}
