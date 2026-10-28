// Shared vertical layout for steelwork, cargo, labels and robot handoffs.
export function rackLevels(r){
 const base=Math.min(.35,.2+r.height*.02);
 return {base,gap:(r.height-base)/r.shelves};
}
export function shelfBase(r,index){const {base,gap}=rackLevels(r);return base+index*gap;}

export function palletHeight(r){return Math.min(.16,rackLevels(r).gap*.13);}

// Keep timber off the steel surface to avoid coplanar depth flicker.
export const palletBaseOffset=.13;
