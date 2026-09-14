import React,{useEffect,useState} from "react";
import{createRoot}from"react-dom/client";
import{Box,ChevronRight,ExternalLink,PackageOpen as LunchboxIcon,Plus,Sparkles,Wallet,X}from"lucide-react";
import{createPublicClient,createWalletClient,custom,decodeEventLog,defineChain,http,keccak256,toHex}from"viem";
import{ActivityPage,AdminPage,DocsPage,RevenuePage,TechSections,TreasuryPage}from"./launchify-pages";
import{AgentChat}from"./agent-ui";
import{launchCmeToken,marketPreset,PadBuilderForm,useMarketTargets}from"./market-ui";
import{ensureRobinhoodChain,useWalletProviders}from"./wallets";
import"./styles.css";
import"./brand-subdomains.css";

const API=import.meta.env.VITE_API_URL||"https://lunchbox-api-production.up.railway.app";
const FACTORY="0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e",ZERO="0x0000000000000000000000000000000000000000";
const chain=defineChain({id:4663,name:"Robinhood Chain",nativeCurrency:{name:"Ether",symbol:"ETH",decimals:18},rpcUrls:{default:{http:["https://rpc.mainnet.chain.robinhood.com"]}},blockExplorers:{default:{name:"Blockscout",url:"https://robinhoodchain.blockscout.com"}}});
const registryAbi=[{type:"function",name:"registerPad",stateMutability:"nonpayable",inputs:[{name:"padId",type:"bytes32"},{name:"padOwner",type:"address"},{name:"slug",type:"string"},{name:"metadataURI",type:"string"}],outputs:[]}];
const splitterFactoryAbi=[{type:"function",name:"createSplitter",stateMutability:"nonpayable",inputs:[{name:"launchId",type:"bytes32"},{name:"creator",type:"address"},{name:"operator",type:"address"}],outputs:[{name:"splitter",type:"address"}]},{type:"function",name:"predictSplitter",stateMutability:"view",inputs:[{name:"launchId",type:"bytes32"},{name:"creator",type:"address"},{name:"operator",type:"address"}],outputs:[{type:"address"}]}];
const factoryAbi=[{type:"function",name:"launchFee",stateMutability:"view",inputs:[],outputs:[{type:"uint256"}]},{type:"function",name:"launchConfigCount",stateMutability:"view",inputs:[],outputs:[{type:"uint256"}]},{type:"function",name:"canLaunch",stateMutability:"view",inputs:[{type:"address"}],outputs:[{type:"bool"}]},{type:"function",name:"previewLaunchEconomics",stateMutability:"view",inputs:[{type:"uint256"},{type:"address"}],outputs:[{type:"bytes32"}]},{type:"function",name:"getLaunchConfig",stateMutability:"view",inputs:[{type:"uint256"}],outputs:[{type:"tuple",components:[{name:"supply",type:"uint256"},{name:"curveFeeBps",type:"uint256"},{name:"phantomQuote",type:"uint256"},{name:"graduationThreshold",type:"uint256"},{name:"poolFee",type:"uint24"},{name:"tickSpacing",type:"int24"},{name:"enabled",type:"bool"}]}]},{type:"function",name:"launchToken",stateMutability:"payable",inputs:[{name:"params",type:"tuple",components:[{name:"name",type:"string"},{name:"symbol",type:"string"},{name:"logo",type:"string"},{name:"description",type:"string"},{name:"socials",type:"tuple",components:[{name:"twitter",type:"string"},{name:"telegram",type:"string"},{name:"discord",type:"string"},{name:"website",type:"string"},{name:"farcaster",type:"string"}]},{name:"creatorFeeRecipient",type:"address"},{name:"creatorTaxBps",type:"uint16"},{name:"buybackEnabled",type:"bool"},{name:"expectedEconomics",type:"bytes32"},{name:"salt",type:"bytes32"}]},{name:"launchConfigId",type:"uint256"},{name:"pairToken",type:"address"}],outputs:[{type:"address"},{type:"address"}]},{type:"event",name:"TokenLaunched",anonymous:false,inputs:[{name:"token",type:"address",indexed:true},{name:"curve",type:"address",indexed:true},{name:"deployer",type:"address",indexed:true},{name:"pairToken",type:"address",indexed:false},{name:"launchConfigId",type:"uint256",indexed:false},{name:"graduationThreshold",type:"uint256",indexed:false}]}];

const short=a=>a?`${a.slice(0,6)}…${a.slice(-4)}`:"";
const errorMessage=e=>e?.shortMessage||e?.message||"Something spilled";
const DOMAIN_SUFFIX=".lunchpad.family",RESERVED_SUBDOMAINS=new Set(["www","api"]);
const domainPadSlug=location.hostname.endsWith(DOMAIN_SUFFIX)?location.hostname.slice(0,-DOMAIN_SUFFIX.length):"";
const activeSubdomain=/^[a-z0-9-]+$/.test(domainPadSlug)&&!RESERVED_SUBDOMAINS.has(domainPadSlug)?domainPadSlug:"";
const mainSiteUrl=activeSubdomain?"https://www.lunchpad.family/":"/";
const storefrontUrl=slug=>["localhost","127.0.0.1"].includes(location.hostname)||location.hostname.endsWith(".vercel.app")?`/pad/${slug}`:`https://${slug}.lunchpad.family/`;
function Brand(){return <a className="brand" href={mainSiteUrl} aria-label="Lunchbox home"><img className="brandLogo" src="/lunchbox-logo.png" alt="Lunchbox — Launchpad Kitchen"/></a>}
function SocialX(){return <a className="socialX" href="https://x.com/Lunchfamilypad" target="_blank" rel="noreferrer" aria-label="Follow Lunchpad Family on X"><span aria-hidden="true">𝕏</span></a>}
async function json(path,options){const r=await fetch(`${API}${path}`,options);const raw=await r.text();let d={};try{d=raw?JSON.parse(raw):{}}catch{throw new Error(r.ok?"Lunchbox returned an invalid response":`Lunchbox request failed (${r.status})`)}if(!r.ok)throw new Error(d.error||d.message||`Lunchbox request failed (${r.status})`);return d;}
async function uploadMedia(file,jwt){if(!file)return"";if(file.size>1_500_000)throw new Error("Image must be smaller than 1.5 MB");const dataUrl=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file)});return(await json("/v1/media",{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${jwt}`},body:JSON.stringify({dataUrl})})).url}

function App(){
 if(activeSubdomain)return <PadPage slug={activeSubdomain}/>;
 const route=location.pathname.match(/^\/pad\/([a-z0-9-]+)$/);if(route)return <PadPage slug={route[1]}/>;const admin=location.pathname.match(/^\/admin\/([a-z0-9-]+)$/);if(admin)return <AdminPage slug={admin[1]}/>;if(location.pathname==="/activity")return <ActivityPage/>;if(location.pathname==="/revenue")return <RevenuePage/>;if(location.pathname==="/docs")return <DocsPage/>;if(location.pathname==="/treasury")return <TreasuryPage/>;
 const[wallet,setWallet]=useState("");const[provider,setProvider]=useState(null);const[token,setToken]=useState("");const[pads,setPads]=useState([]);const[open,setOpen]=useState(false);const[walletOpen,setWalletOpen]=useState(false);const[pendingPreset,setPendingPreset]=useState(null);const[busy,setBusy]=useState("");const[note,setNote]=useState("");const[walletError,setWalletError]=useState("");
 const[form,setForm]=useState({name:"",slug:"",niche:"Community",description:"",accent:"#ffcc33",creatorTaxBps:200,marketType:"community",templateKey:"classic",ecosystemInspiration:"robinhood-native",allowedMarkets:[],agentName:"My Lunchmate",agentTone:"funny",agentPersonality:"A sharp, funny guide who explains this launchpad without hype.",image:null});
 useEffect(()=>{json("/v1/pads?limit=100").then(d=>setPads(d.pads)).catch(e=>setNote(errorMessage(e)))},[]);
 const walletOptions=useWalletProviders();
 useEffect(()=>{if(!provider?.on)return;const accountsChanged=accounts=>{setWallet(accounts?.[0]||"");setToken("")};const disconnected=()=>{setWallet("");setProvider(null);setToken("")};provider.on("accountsChanged",accountsChanged);provider.on("disconnect",disconnected);return()=>{provider.removeListener?.("accountsChanged",accountsChanged);provider.removeListener?.("disconnect",disconnected)}},[provider]);
 async function connect(item){try{setWalletError("");const accounts=await item.provider.request({method:"eth_requestAccounts"});if(!accounts?.[0])throw new Error(`${item.label} did not return an account`);setWallet(accounts[0]);setProvider(item.provider);setWalletOpen(false);if(pendingPreset!==null){setOpen(true);setPendingPreset(null)}}catch(e){setWalletError(errorMessage(e))}}
 function disconnect(){setWallet("");setProvider(null);setToken("");setWalletError("");setNote("Operator wallet disconnected.")}
 function openBuilder(preset={}){const normalized=preset.marketType?{...marketPreset(preset.marketType),...preset}:preset;setForm(current=>({...current,...normalized}));if(wallet)setOpen(true);else{setPendingPreset(normalized);setWalletOpen(true)}}
 async function auth(){if(token)return token;if(!wallet||!provider)throw new Error("Connect a wallet first");const c=await json(`/v1/auth/challenge?wallet=${wallet}`);const signature=await provider.request({method:"personal_sign",params:[c.message,wallet]});const v=await json("/v1/auth/verify",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({wallet,signature})});setToken(v.token);return v.token;}
 async function createPad(e){
  e.preventDefault();
  try{
   setBusy("Checking the kitchen rails…");setNote("");
   const cfg=await json("/v1/config");if(!cfg.registryAddress)throw new Error("Lunchbox protocol contracts are unavailable");
   if(["stocks","commodities"].includes(form.marketType)&&!form.allowedMarkets.length)throw new Error("Choose at least one live market for this lunchpad");
   const jwt=await auth();setBusy("Uploading the lunchbox art…");const logoUrl=await uploadMedia(form.image,jwt);
   setBusy("Packing your lunchpad…");
   const{image,agentName,agentTone,agentPersonality,...padForm}=form;
   const pad=await json("/v1/pads",{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${jwt}`},body:JSON.stringify({...padForm,logoUrl:logoUrl||null})});
   await ensureRobinhoodChain(provider);
   const wc=createWalletClient({account:wallet,chain,transport:custom(provider)}),pc=createPublicClient({chain,transport:http()});
   const padId=keccak256(toHex(pad.id));setBusy("Sign the lid onchain…");
   const hash=await wc.writeContract({address:cfg.registryAddress,abi:registryAbi,functionName:"registerPad",args:[padId,wallet,pad.slug,`${API}/v1/pads/${pad.slug}`]});
   await pc.waitForTransactionReceipt({hash});
   await json(`/v1/pads/${pad.id}/register`,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${jwt}`},body:JSON.stringify({transactionHash:hash})});
   let agentReady=false;
   if(form.marketType==="agents"){
    setBusy("Giving your lunchmate a brain…");
    try{await json(`/v1/agent-admin/${pad.id}`,{method:"PUT",headers:{"content-type":"application/json",authorization:`Bearer ${jwt}`},body:JSON.stringify({name:agentName,personality:agentPersonality,tone:agentTone,knowledge:`${pad.name} is an AI agents lunchpad on Robinhood Chain. ${pad.description}`,rules:"Use only approved project facts and verified launches. Never invent prices, partnerships, returns or wallet activity.",welcomeMessage:`Hey, I'm ${agentName}. Ask me what's packed in ${pad.name}.`,status:"active",socialMode:"disabled"})});agentReady=true}catch(error){setNote(`Lunchpad is live. Agent setup needs attention: ${errorMessage(error)}`)}
   }
   setPads(current=>[{...pad,status:"active"},...current]);setOpen(false);
   if(form.marketType!=="agents"||agentReady)setNote(form.marketType==="agents"?"Lunchpad and AI agent unpacked and live.":"Lunchpad unpacked and live.");
  }catch(error){setNote(errorMessage(error))}finally{setBusy("")}
 }
 return <main><header><Brand/><nav><a href="#subdomains">Subdomains</a><a href="#markets">Markets</a><a href="#templates">Templates</a><a href="#directory">Lunchpads</a><a href="/activity">Activity</a><a href="/revenue">Revenue</a><a href="/docs">Docs</a><a href="/treasury">Treasury</a></nav><SocialX/><button className="wallet" title={wallet?"Disconnect wallet":"Connect wallet"} onClick={()=>wallet?disconnect():(setPendingPreset(null),setWalletOpen(true))}><Wallet size={17}/><span>{wallet?`Disconnect ${short(wallet)}`:"Connect operator"}</span></button></header>
 <section className="hero"><div className="eyebrow"><Sparkles size={15}/> PONS V2 · ROBINHOOD CHAIN</div><h1>Pack your own<br/><em>launchpad.</em></h1><p>Create a branded token launchpad with isolated ownership and automatic fee routing. No sad desk lunch required.</p><div className="actions"><button className="primary" onClick={()=>openBuilder()}>Build my lunchbox <ChevronRight/></button><a className="ghost" href="#directory">Browse the cafeteria</a></div><div className="fee"><span><b>70%</b> creator</span><span><b>20%</b> lunchpad owner</span><span><b>10%</b> protocol</span></div><LunchArt/></section>
 <section id="subdomains" className="subdomainBand"><div><span className="kicker">A FRONT DOOR FOR EVERY BOX</span><h2>your-pad.lunchpad.family</h2><p>Every deployed lunchpad gets its own public subdomain automatically—one clean link for its branded storefront, launches and AI lunchmate.</p></div><button className="primary" onClick={()=>openBuilder()}>Claim your address <ChevronRight/></button></section>
 <TechSections onBuild={openBuilder}/><section id="directory" className="directory"><div className="sectionHead"><div><span className="kicker">TODAY'S MENU</span><h2>Fresh lunchpads</h2></div><button className="round" aria-label="Create a lunchpad" onClick={()=>openBuilder()}><Plus/></button></div>{note&&<div className="notice" role="status">{note}</div>}<div className="grid">{pads.length?pads.map(p=><article className="card" key={p.id} style={{"--accent":p.accent}}><div className="cardTop"><div className="padLogo">{p.logoUrl?<img src={p.logoUrl} alt={`${p.name} logo`}/>:<Box/>}</div><span className={`status ${p.status}`}>{p.status}</span></div><h3>{p.name}</h3><p>{p.description}</p><a className="storefrontAddress" href={storefrontUrl(p.slug)}>{p.slug}.lunchpad.family <ExternalLink size={13}/></a><div className="meta"><span>{p.niche}</span><span>{p.creatorTaxBps/100}% tax</span><span>{p.launches||0} launches</span></div><div className="cardLinks"><a href={storefrontUrl(p.slug)}>Open lunchbox <ExternalLink size={15}/></a><a href={`/admin/${p.slug}`}>Owner dashboard</a></div></article>):<div className="empty"><LunchboxIcon/><h3>The cafeteria is empty.</h3><p>Be the first to pack a lunchpad.</p><button className="primary" onClick={()=>openBuilder()}>Pack the first one</button></div>}</div></section>
 <section id="how" className="how"><span className="kicker">HOW IT COOKS</span><div className="steps"><div><b>01</b><h3>Pack the brand</h3><p>Name it, theme it and choose a 2–4% creator tax.</p></div><div><b>02</b><h3>Sign the lid</h3><p>Your wallet registers isolated launchpad ownership onchain.</p></div><div><b>03</b><h3>Serve launches</h3><p>Pons V2 launches route fees automatically through verified splitters.</p></div></div></section>
 {walletOpen&&<Modal label="Choose a wallet" close={()=>{setWalletOpen(false);setWalletError("");setPendingPreset(null)}}><h2>Pick your wallet</h2><p>Choose deliberately. Lunchbox connects only to the wallet you select.</p>{walletError&&<div className="notice" role="alert">{walletError}</div>}<div className="walletList">{walletOptions.length?walletOptions.map(x=><button key={x.key} onClick={()=>connect(x)}>{x.label}<ChevronRight/></button>):<div className="notice">No supported wallet detected. Install or unlock MetaMask, Trust Wallet, or Phantom, then reopen this menu.</div>}</div></Modal>}
 {open&&<Modal label="New lunchpad deployment" close={()=>setOpen(false)}><span className="kicker">NEW LUNCHPAD DEPLOYMENT</span><h2>Pack a launch business</h2><p>Configure its storefront, operating lane and public identity. Your chosen address becomes a live <b>slug.lunchpad.family</b> subdomain.</p><PadBuilderForm form={form} setForm={setForm} onSubmit={createPad} busy={busy}/></Modal>}
 </main>
}
function PadPage({slug}){
 const[data,setData]=useState(null),[wallet,setWallet]=useState(""),[provider,setProvider]=useState(null),[busy,setBusy]=useState(""),[note,setNote]=useState("");
 const[form,setForm]=useState({name:"",symbol:"",description:"",website:"",marketTargetKey:"",feeBps:200,firstBuyEth:"0.001",image:null});
 const walletOptions=useWalletProviders();
 const marketType=data?.pad?.marketType||"";
 const{targets:liveTargets,loading:marketsLoading,warning:marketWarning}=useMarketTargets(marketType);
 const launchTargets=data?.pad?.allowedMarkets?.length?data.pad.allowedMarkets:liveTargets;
 const selectedTarget=launchTargets.find(x=>x.key===form.marketTargetKey);
 const isCme=marketType==="commodities";
 useEffect(()=>{json(`/v1/pads/${slug}`).then(setData).catch(e=>setNote(errorMessage(e)))},[slug]);
 useEffect(()=>{if(launchTargets.length&&!form.marketTargetKey)setForm(current=>({...current,marketTargetKey:launchTargets[0].key}))},[launchTargets,form.marketTargetKey]);
 useEffect(()=>{if(!provider?.on)return;const accountsChanged=accounts=>setWallet(accounts?.[0]||"");const disconnected=()=>{setWallet("");setProvider(null)};provider.on("accountsChanged",accountsChanged);provider.on("disconnect",disconnected);return()=>{provider.removeListener?.("accountsChanged",accountsChanged);provider.removeListener?.("disconnect",disconnected)}},[provider]);
 async function connect(item){try{setNote("");const accounts=await item.provider.request({method:"eth_requestAccounts"});if(!accounts?.[0])throw new Error(`${item.label} did not return an account`);setWallet(accounts[0]);setProvider(item.provider)}catch(error){setNote(errorMessage(error))}}
 async function authenticate(){const c=await json(`/v1/auth/challenge?wallet=${wallet}`);const signature=await provider.request({method:"personal_sign",params:[c.message,wallet]});return(await json("/v1/auth/verify",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({wallet,signature})})).token}
 async function launch(e){
  e.preventDefault();
  try{
   if(!wallet||!provider)throw new Error("Choose and connect your wallet first");
   if(["stocks","commodities"].includes(marketType)&&!selectedTarget)throw new Error("Choose a live market first");
   setBusy("Opening the lunchbox…");setNote("");
   const jwt=await authenticate();const logo=await uploadMedia(form.image,jwt);
   if(isCme){
    setBusy("Cooking the CME V6 launch…");
    const launch=await launchCmeToken({account:wallet,provider,chain,input:{name:form.name,symbol:form.symbol.toUpperCase(),description:form.description,image:logo,website:form.website||storefrontUrl(slug),pairId:Number(selectedTarget.pairId),feeBps:Number(form.feeBps),firstBuyEth:form.firstBuyEth}});
    const record=await json(`/v1/pads/${data.pad.id}/launches`,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${jwt}`},body:JSON.stringify({provider:"cme-v6",tokenName:form.name,tokenSymbol:form.symbol.toUpperCase(),tokenLogoUrl:logo||null,transactionHash:launch.hash,marketTarget:selectedTarget,launchId:launch.id})});
    setData(current=>({...current,launches:[record,...current.launches]}));
   }else{
    const cfg=await json("/v1/config");if(!cfg.splitterFactoryAddress)throw new Error("Lunchbox protocol contracts need their one-time deployment first");
    await ensureRobinhoodChain(provider);
    const pc=createPublicClient({chain,transport:http()}),wc=createWalletClient({account:wallet,chain,transport:custom(provider)});
    const pairToken=marketType==="stocks"?selectedTarget.address:ZERO;
    const launchKey=keccak256(toHex(`lunchbox:${data.pad.id}:${wallet}:${Date.now()}`));
    setBusy("Preparing fee compartments…");
    const splitter=await pc.readContract({address:cfg.splitterFactoryAddress,abi:splitterFactoryAbi,functionName:"predictSplitter",args:[launchKey,wallet,data.pad.ownerWallet]});
    const splitHash=await wc.writeContract({address:cfg.splitterFactoryAddress,abi:splitterFactoryAbi,functionName:"createSplitter",args:[launchKey,wallet,data.pad.ownerWallet]});
    await pc.waitForTransactionReceipt({hash:splitHash});setBusy("Cooking the Pons launch…");
    const[launchFee,count,allowed]=await Promise.all([pc.readContract({address:FACTORY,abi:factoryAbi,functionName:"launchFee"}),pc.readContract({address:FACTORY,abi:factoryAbi,functionName:"launchConfigCount"}),pc.readContract({address:FACTORY,abi:factoryAbi,functionName:"canLaunch",args:[wallet]})]);
    if(!allowed)throw new Error("This wallet is not currently permitted by the Pons factory");
    let configId;for(let i=0n;i<count;i++){const c=await pc.readContract({address:FACTORY,abi:factoryAbi,functionName:"getLaunchConfig",args:[i]});if(c.enabled){configId=i;break}}
    if(configId===undefined)throw new Error("Pons has no enabled launch configuration");
    const economics=await pc.readContract({address:FACTORY,abi:factoryAbi,functionName:"previewLaunchEconomics",args:[configId,pairToken]});
    const params={name:form.name,symbol:form.symbol.toUpperCase(),logo,description:form.description,socials:{twitter:"",telegram:"",discord:"",website:form.website||storefrontUrl(slug),farcaster:""},creatorFeeRecipient:splitter,creatorTaxBps:data.pad.creatorTaxBps,buybackEnabled:true,expectedEconomics:economics,salt:keccak256(toHex(`lunchbox:${wallet}:${Date.now()}`))};
    const hash=await wc.writeContract({address:FACTORY,abi:factoryAbi,functionName:"launchToken",args:[params,configId,pairToken],value:launchFee});
    await pc.waitForTransactionReceipt({hash,confirmations:1});
    const record=await json(`/v1/pads/${data.pad.id}/launches`,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${jwt}`},body:JSON.stringify({provider:"pons-v2",tokenName:form.name,tokenSymbol:form.symbol.toUpperCase(),tokenLogoUrl:logo||null,transactionHash:hash,splitterAddress:splitter,launchKey,pairToken,marketTarget:selectedTarget||undefined})});
    setData(current=>({...current,launches:[record,...current.launches]}));
   }
   setNote("Lunch served. Your token is live.");
   setForm(current=>({name:"",symbol:"",description:"",website:"",marketTargetKey:current.marketTargetKey,feeBps:current.feeBps,firstBuyEth:current.firstBuyEth,image:null}));
  }catch(error){setNote(errorMessage(error))}finally{setBusy("")}
 }
 if(!data)return <main><header><Brand/></header><section className="directory"><div className="notice">{note||"Loading today's menu…"}</div></section></main>;
 const providerLabel=isCme?"CME V6":marketType==="agents"?"AI17Z + Pons V2":"Pons V2";
 return <main><header><Brand/><a className="wallet" href={mainSiteUrl}>All lunchpads</a></header>
  <section className="padHero" style={{"--accent":data.pad.accent}}><span className="kicker">LUNCHPAD / {data.pad.status}</span><h1>{data.pad.name}</h1><p>{data.pad.description}</p><div className="meta"><span>{data.pad.niche}</span><span>{providerLabel}</span>{!isCme&&<><span>{data.pad.creatorTaxBps/100}% creator tax</span><span>70 / 20 / 10 split</span></>}</div></section>
  <section className="launchArea"><div><span className="kicker">PACK A TOKEN · {providerLabel}</span><h2>Put a launch in the box.</h2><p>{isCme?"Launch a market-linked token directly through Commodity Market Exchange V6. Pick the index, trading fee and opening buy.":marketType==="stocks"?"Choose an approved Robinhood stock pair, then sign the Pons V2 launch with verified fee routing.":"The creator signs the Pons V2 launch. Fees route through a verified splitter to the creator, this lunchpad owner and the protocol."}</p>{marketWarning&&<div className="notice">{marketWarning}</div>}{note&&<div className="notice">{note}</div>}{!wallet?<div className="walletList">{walletOptions.length?walletOptions.map(x=><button key={x.key} onClick={()=>connect(x)}>{x.label}<ChevronRight/></button>):<div className="notice">No supported wallet detected. Install or unlock MetaMask, Trust Wallet, or Phantom.</div>}</div>:<button type="button" className="connected" title="Disconnect wallet" onClick={()=>{setWallet("");setProvider(null)}}><Wallet size={16}/> Disconnect {short(wallet)}</button>}</div>
   <form className="launchForm" onSubmit={launch}>{["stocks","commodities"].includes(marketType)&&<label>{isCme?"CME commodity index":"Stock pair"}<select required disabled={marketsLoading||!launchTargets.length} value={form.marketTargetKey} onChange={e=>setForm({...form,marketTargetKey:e.target.value})}><option value="">{marketsLoading?"Loading live markets…":"Choose a market"}</option>{launchTargets.map(target=><option key={target.key} value={target.key}>{target.label}</option>)}</select></label>}<label>Token name<input required maxLength="48" value={form.name} onChange={e=>setForm({...form,name:e.target.value})}/></label><label>Ticker<input required maxLength="12" value={form.symbol} onChange={e=>setForm({...form,symbol:e.target.value.replace(/[^a-z0-9]/gi,"")})}/></label><label>Description<textarea required maxLength="220" value={form.description} onChange={e=>setForm({...form,description:e.target.value})}/></label><label>Website<input type="url" value={form.website} onChange={e=>setForm({...form,website:e.target.value})}/></label>{isCme&&<div className="two"><label>Trading fee<select value={form.feeBps} onChange={e=>setForm({...form,feeBps:Number(e.target.value)})}><option value="100">1%</option><option value="200">2%</option><option value="300">3%</option></select></label><label>Opening buy (ETH)<input required type="number" min="0.0001" step="0.0001" value={form.firstBuyEth} onChange={e=>setForm({...form,firstBuyEth:e.target.value})}/></label></div>}<label>Token image<input required type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={e=>setForm({...form,image:e.target.files?.[0]||null})}/></label>{isCme&&<div className="feePreview"><b>Direct CME V6 launch</b> · synthetic reference-price token, not a claim on a physical commodity</div>}<button className="primary" disabled={!!busy||data.pad.status!=="active"}>{busy||`Launch with ${providerLabel}`}</button></form>
  </section><AgentChat slug={slug} pad={data.pad}/><section className="directory"><span className="kicker">SERVED RECENTLY</span><div className="grid">{data.launches.length?data.launches.map(l=><article className="card" key={l.id} style={{"--accent":data.pad.accent}}><div className="cardTop"><div className="padLogo">{l.token_logo_url?<img src={l.token_logo_url} alt={`${l.token_name} logo`}/>:<Box/>}</div><span className="status active">live</span></div><h3>{l.token_name} <small>${l.token_symbol}</small></h3><p>{l.market_target_label||providerLabel} · {short(l.token_address)}</p><a href={`https://robinhoodchain.blockscout.com/tx/${l.transaction_hash}`} target="_blank" rel="noreferrer">View transaction <ExternalLink size={15}/></a></article>):<div className="empty"><Box/><h3>Nothing packed yet.</h3><p>The first launch gets the big compartment.</p></div>}</div></section></main>;
}
function Modal({children,close,label="Lunchbox dialog"}){useEffect(()=>{const onKey=e=>e.key==="Escape"&&close();document.addEventListener("keydown",onKey);return()=>document.removeEventListener("keydown",onKey)},[close]);return <div className="overlay" onMouseDown={e=>e.target===e.currentTarget&&close()}><div className="modal" role="dialog" aria-modal="true" aria-label={label}><button className="close" aria-label="Close dialog" onClick={close}><X/></button>{children}</div></div>}
function LunchArt(){return <div className="art" aria-hidden="true"><div className="handle"/><div className="box"><div className="sticker">LUNCH<br/>PAD</div><div className="sandwich">🥪</div><div className="rocket">↗</div></div><span className="crumb c1">✦</span><span className="crumb c2">●</span><span className="crumb c3">+</span></div>}
createRoot(document.getElementById("root")).render(<App/>);
