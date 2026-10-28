import {assetParts,cartonObject} from './warehouse-assets.js';
import {palletHeight} from './rack-levels.js';
import {shelfBase} from './rack-levels.js';
import * as T from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {rackParts} from './rack-geometry.js';
const view=document.querySelector('#view'),out=document.querySelector('#output'),ctx=out.getContext('2d'),source=document.querySelector('#source');
const renderer=new T.WebGLRenderer({canvas:source,antialias:true,alpha:true,preserveDrawingBuffer:true});renderer.setPixelRatio(1);renderer.setClearColor(0xffffff,0);renderer.outputColorSpace=T.SRGBColorSpace;
const scene=new T.Scene(),camera=new T.OrthographicCamera(-10,10,9,-9,.1,100);camera.position.set(13,12,18);const controls=new OrbitControls(camera,out);controls.target.set(0,3.5,0);controls.enableDamping=true;controls.enablePan=false;controls.minZoom=.6;controls.maxZoom=2.2;controls.maxPolarAngle=Math.PI*.49;controls.update();
renderer.shadowMap.enabled=true;renderer.shadowMap.type=T.PCFSoftShadowMap;scene.add(new T.HemisphereLight(0xffffff,0x727184,1.25));let sun=new T.DirectionalLight(0xffffff,2.4);sun.position.set(-10,20,15);sun.castShadow=true;sun.shadow.mapSize.set(2048,2048);Object.assign(sun.shadow.camera,{left:-12,right:12,top:14,bottom:-12,near:.1,far:60});sun.shadow.normalBias=.025;scene.add(sun);
let color='#6552a3',raster=true,showBoxes=false,pixel=55,w=0,h=0,dirty=true;const geom=new T.BoxGeometry(1,1,1),rack=new T.Group();scene.add(rack);let accent=new T.MeshStandardMaterial({color,roughness:.9}),beam=new T.MeshStandardMaterial({color:'#403859',roughness:.9}),frame=new T.MeshStandardMaterial({color:'#a5a7a3',roughness:.8}),dark=new T.MeshStandardMaterial({color:'#6c6f70',roughness:.8});
for(let p of rackParts({width:6,depth:4,height:7.3,shelves:5,places:4})){if(p.kind==='hardware')continue;
// Keep shelf members inside the uprights: shared coplanar faces flicker when orbiting.
if(p.kind==='beam'&&p.size[0]>1)p.size[0]-=.26;
if(p.kind==='beam'&&Math.abs(p.p[0])===3){p.p[0]-=Math.sign(p.p[0])*.15;p.size[2]-=.24;}
if(p.kind==='deck'){if(Math.abs(p.p[0])>2){p.size[0]-=.10;p.p[0]-=Math.sign(p.p[0])*.05;}p.size[2]-=.12;}
let m=new T.Mesh(p.kind==='pallet'?assetParts.pallet[0].geometry:geom,p.kind==='pallet'?assetParts.pallet[0].material:p.kind==='deck'?accent:p.kind==='beam'?beam:p.kind==='brace'?dark:frame);if(p.from){let a=new T.Vector3(...p.from),b=new T.Vector3(...p.to),d=b.clone().sub(a);m.position.copy(a.add(b).multiplyScalar(.5));m.quaternion.setFromUnitVectors(new T.Vector3(0,1,0),d.clone().normalize());m.scale.set(p.thickness,d.length(),p.thickness);}else{m.position.set(...p.p);m.scale.set(...p.size);}m.castShadow=true;m.receiveShadow=true;rack.add(m);}

let cargo=new T.Group();scene.add(cargo);for(let y=0;y<5;y++)for(let x=0;x<4;x++){if((x+y)%4===0)continue;cartonObject(cargo,-2.2+x*1.45,shelfBase({height:7.3,shelves:5},y)+.115+palletHeight({height:7.3,shelves:5})+.49,.3,1.1,.98,1.8);}cargo.visible=false;
const read=document.createElement('canvas'),readCtx=read.getContext('2d',{willReadFrequently:true});
function resize(){w=view.clientWidth;h=view.clientHeight;out.width=w*2;out.height=h*2;camera.left=-9*w/h;camera.right=9*w/h;camera.top=9;camera.bottom=-9;camera.updateProjectionMatrix();dirty=true;}
new ResizeObserver(resize).observe(view);controls.addEventListener('change',()=>dirty=true);
const bayer=[0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5];
function render(){controls.update();if(!dirty||w<1||h<1)return;dirty=false;let scale=.5,rw=Math.ceil(w/scale),rh=Math.ceil(h/scale);renderer.setSize(rw,rh,false);renderer.render(scene,camera);ctx.fillStyle='#f5f5ef';ctx.fillRect(0,0,w*2,h*2);ctx.imageSmoothingEnabled=false;if(!raster){ctx.drawImage(source,0,0,w*2,h*2);return;}read.width=rw;read.height=rh;readCtx.drawImage(source,0,0);let data=readCtx.getImageData(0,0,rw,rh),a=data.data;
// Opaque two-tone checker: visible raster without dissolving the silhouette.
for(let y=0;y<rh;y++)for(let x=0;x<rw;x++){let i=(y*rw+x)*4;if(a[i+3]<20)continue;
let lum=(a[i]*.2126+a[i+1]*.7152+a[i+2]*.0722)/255;
let light=(Math.floor(x/6)+Math.floor(y/6))%2===0;
let amount=pixel/100;
// Preserve dark edges; lift alternating surface cells toward warm paper.
let strength=amount*(.32+.38*Math.min(1,lum*2));
for(let c=0;c<3;c++){let paper=c===2?239:245;a[i+c]=Math.round(light?a[i+c]+(paper-a[i+c])*strength:a[i+c]*(1-amount*.13));}}
readCtx.putImageData(data,0,0);ctx.drawImage(read,0,0,w*2,h*2);}
renderer.setAnimationLoop(render);
function mode(value){raster=value;document.querySelector('#raster').classList.toggle('active',value);document.querySelector('#solid').classList.toggle('active',!value);document.querySelector('#pixels').disabled=!value;dirty=true;}
document.querySelector('#raster').onclick=()=>mode(true);document.querySelector('#solid').onclick=()=>mode(false);document.querySelector('#pixels').oninput=e=>{pixel=Number(e.target.value);dirty=true;};document.querySelectorAll('[data-color]').forEach(b=>b.onclick=()=>{color=b.dataset.color;accent.color.set(color);document.querySelectorAll('[data-color]').forEach(x=>x.classList.toggle('active',x===b));dirty=true;});document.querySelector('#boxes').onclick=e=>{showBoxes=!showBoxes;cargo.visible=showBoxes;e.target.textContent=showBoxes?'Hide boxes':'Show boxes';e.target.classList.toggle('active',showBoxes);dirty=true;};document.querySelector('#reset').onclick=()=>{camera.position.set(13,12,18);camera.zoom=1;camera.updateProjectionMatrix();controls.target.set(0,3.5,0);controls.update();dirty=true;};
