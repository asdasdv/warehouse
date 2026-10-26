// Thresholds describe occupied storage addresses, not the decorative box count.
export function flowPolicy(used,total,waiting,previous='Balanced'){
 const ratio=total>0?Math.min(1,used/total):0;
 let mode=previous;
 if(ratio>=.85)mode='Prioritize shipping';
 else if(ratio<=.45)mode='Prioritize receiving';
 else if(mode==='Prioritize shipping'&&ratio<.75||mode==='Prioritize receiving'&&ratio>.6)mode='Balanced';
 return {mode,ratio,used,total,free:Math.max(0,total-used),arrivalInterval:mode==='Prioritize receiving'?6:mode==='Prioritize shipping'?30:12,
  acceptArrivals:total>0&&ratio<.98,
  inboundShare:mode==='Prioritize receiving'?3:mode==='Prioritize shipping'?1:2,
  fleetTarget:waiting>=10?8:waiting>=6||mode==='Prioritize shipping'?6:4};
}
