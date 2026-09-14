import{useEffect,useState}from"react";

const WALLET_DEFS=[
 {key:"metamask",label:"MetaMask"},
 {key:"trust",label:"Trust Wallet"},
 {key:"phantom",label:"Phantom"}
];

function walletKey(info,provider){
 const rdns=String(info?.rdns||"").toLowerCase();
 const name=String(info?.name||"").toLowerCase();
 if(rdns.includes("trustwallet")||name.includes("trust wallet")||provider?.isTrust||provider?.isTrustWallet)return"trust";
 if(rdns.includes("phantom")||name.includes("phantom")||provider?.isPhantom)return"phantom";
 if(rdns==="io.metamask"||rdns.endsWith(".metamask")||name==="metamask"||(provider?.isMetaMask&&!provider?.isTrust&&!provider?.isTrustWallet&&!provider?.isPhantom))return"metamask";
 return"";
}

export function useWalletProviders(){
 const[items,setItems]=useState([]);
 useEffect(()=>{
  if(typeof window==="undefined")return;
  const found=new Map();
  const sync=()=>setItems(WALLET_DEFS.flatMap(def=>{const item=found.get(def.key);return item?[{...def,...item}]:[]}));
  const add=(provider,info={})=>{
   if(!provider?.request)return;
   const key=walletKey(info,provider);
   if(!key)return;
   const current=found.get(key);
   if(!current||info?.uuid){found.set(key,{provider,info});sync()}
  };
  const announce=e=>add(e?.detail?.provider,e?.detail?.info);
  window.addEventListener("eip6963:announceProvider",announce);
  const eth=window.ethereum;
  for(const provider of eth?.providers?.length?eth.providers:eth?[eth]:[])add(provider);
  add(window.phantom?.ethereum,{name:"Phantom",rdns:"app.phantom"});
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  const timer=setTimeout(sync,500);
  return()=>{clearTimeout(timer);window.removeEventListener("eip6963:announceProvider",announce)}
 },[]);
 return items
}

export async function ensureRobinhoodChain(provider){
 try{await provider.request({method:"wallet_switchEthereumChain",params:[{chainId:"0x1237"}]})}
 catch(e){
  if(e?.code!==4902)throw e;
  await provider.request({method:"wallet_addEthereumChain",params:[{chainId:"0x1237",chainName:"Robinhood Chain",nativeCurrency:{name:"Ether",symbol:"ETH",decimals:18},rpcUrls:["https://rpc.mainnet.chain.robinhood.com"],blockExplorerUrls:["https://robinhoodchain.blockscout.com"]}]})
 }
}
