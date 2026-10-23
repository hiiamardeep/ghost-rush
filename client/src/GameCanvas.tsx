import { useEffect, useRef } from 'react';
import Phaser from 'phaser';

export type PlayerState = {
  id: string; name: string; x: number; y: number; vx: number; vy: number;
  attached: boolean; anchorX: number | null; anchorY: number | null;
  finished: boolean; rank: number | null; score: number; finishTime: number | null; color: string;
  connected?: boolean;
  lap?: number;
  collectedOrbs?: number[];
  shieldCharge?: boolean;
  collectedShields?: number[];
};
export type GameState = {
  players: PlayerState[];
  status: 'waiting' | 'racing' | 'finished';
  winner: string | null;
  startedAt?: number;
  totalLaps?: number;
};
type Props = { state: GameState | null; myId: string; onHoldChange: (held: boolean) => void };

const WORLD_WIDTH = 11000;
const WORLD_HEIGHT = 720;
const FINISH_X = 10800;
const TOTAL_LAPS = 3;
const METEOR_COUNT = 28;
const MINE_COUNT = 10;
const makeAnchors = () => Array.from({length: 42}, (_,i) => ({
  x: 320 + i*250, y: 80 + ((Math.sin(i*1.71)+1)*.5)*150
}));
/** Falling meteoroids — must match server meteoroidAt() */
const meteoroidAt = (i: number, now: number, lap: number) => {
  const speedMul = 1 + lap * 0.45;
  const baseSpeed = (90 + (i % 7) * 18) * speedMul;
  const x0 = 200 + (i * 397) % (FINISH_X - 400);
  const drift = ((i * 53) % 120) - 60;
  const fallRange = 900;
  const phase = (i * 0.73) % 1;
  const y = -120 + ((now * baseSpeed + phase * fallRange) % fallRange);
  const x = x0 + drift * Math.sin(now * 0.7 + i);
  const r = 14 + (i % 5) * 3;
  return { x, y, r };
};
/** Lap-based rock colours: cool stone → amber → hot magma */
const meteorColors = (lap: number) => {
  if (lap <= 0) return { body: 0x8b7a9e, core: 0xc4b8d4, glow: 0xa78bfa, trail: 0x6b5b95 };
  if (lap === 1) return { body: 0xc4784a, core: 0xffb070, glow: 0xff8c42, trail: 0xff6b2d };
  return { body: 0xd94a4a, core: 0xff8a6a, glow: 0xff4fd8, trail: 0xff2e63 };
};

/** Pulsing energy mines — deterministic so every racer sees the same hazards. */
const mineAt = (i: number, now: number, lap: number) => {
  const x = 650 + i * 980 + Math.sin(now * (0.65 + i * 0.025) + i) * 105;
  const y = 210 + ((i * 79) % 250) + Math.sin(now * 1.1 + i * 1.7) * (35 + lap * 8);
  return { x, y, r: 19 + (i % 3) * 3 };
};

const spiritOrbAt = (i: number, now: number) => ({
  x: 480 + i * 620,
  y: 180 + ((i * 113) % 330) + Math.sin(now * 1.35 + i * 1.7) * 28,
  r: 17,
});
const shieldAt = (i: number, now: number) => ({
  x: 850 + i * 1250,
  y: 145 + ((i * 97) % 300) + Math.sin(now * 0.9 + i * 1.8) * 24,
  r: 19,
});

export default function GameCanvas({state,myId,onHoldChange}:Props) {
  const hostRef=useRef<HTMLDivElement>(null);
  const sceneRef=useRef<any>(null);
  const stateRef=useRef(state);
  const holdRef=useRef(onHoldChange);
  stateRef.current=state; holdRef.current=onHoldChange;

  useEffect(()=>{
    if(!hostRef.current)return;
    class RushScene extends Phaser.Scene {
      g!:Phaser.GameObjects.Graphics;
      labels=new Map<string,Phaser.GameObjects.Text>();
      finishTitle!:Phaser.GameObjects.Text;
      finishEmitter!:Phaser.GameObjects.Particles.ParticleEmitter;
      held=false;
      finishCelebrated=false;
      lastLap=-1;
      slowMoUntil=0;
      visualTime=0;
      constructor(){super('rush')}
      create(){
        this.g=this.add.graphics();
        const particleTexture=this.make.graphics({x:0,y:0});
        particleTexture.fillStyle(0xffffff,1);
        particleTexture.fillCircle(6,6,6);
        particleTexture.generateTexture('finish-particle',12,12);
        particleTexture.destroy();
        this.finishEmitter=this.add.particles(0,0,'finish-particle',{
          emitting:false,
          speed:{min:220,max:720},
          angle:{min:0,max:360},
          lifespan:{min:700,max:1400},
          scale:{start:1.4,end:0},
          alpha:{start:1,end:0},
          gravityY:320,
          frequency:16,
          quantity:3,
          blendMode:Phaser.BlendModes.ADD,
          tint:[0x00e5ff,0x7cff6b,0xffd84f,0xff4fd8,0xffffff,0xa78bfa]
        });
        this.finishTitle=this.add.text(10812,78,'LAP',{
          fontFamily:'Space Grotesk, Arial',
          fontSize:'19px',
          fontStyle:'bold',
          color:'#aaf8ff',
          stroke:'#11132f',
          strokeThickness:5,
          shadow:{color:'#36dfff',blur:18,fill:true}
        }).setOrigin(0.5);
        this.cameras.main.setBounds(0,0,WORLD_WIDTH,WORLD_HEIGHT);
        this.input.keyboard?.on('keydown-SPACE',(e:any)=>{e?.preventDefault?.();this.setHeld(true)});
        this.input.keyboard?.on('keyup-SPACE',(e:any)=>{e?.preventDefault?.();this.setHeld(false)});
        this.input.keyboard?.addCapture('SPACE');
        this.input.on('pointerdown',()=>this.setHeld(true));
        this.input.on('pointerup',()=>this.setHeld(false));
        this.input.on('gameout',()=>this.setHeld(false));
        sceneRef.current=this;
      }
      setHeld(v:boolean){if(this.held===v)return;this.held=v;holdRef.current(v)}
      update(time:number,delta:number){
        const current=stateRef.current;
        const mine=current?.players.find(p=>p.id===myId);
        if(!mine){this.lastLap=-1;this.finishCelebrated=false;}
        if(mine && this.lastLap < 0) this.lastLap=mine.lap ?? 0;
        if(mine && (mine.lap ?? 0) > this.lastLap){
          this.lastLap=mine.lap ?? 0;
          this.slowMoUntil=time+520;
          this.finishEmitter.emitParticleAt(mine.x,mine.y,34);
          this.cameras.main.flash(180,104,255,213,false);
          this.cameras.main.shake(180,0.004);
        }
        if(!mine||!mine.finished)this.finishCelebrated=false;
        if(mine&&mine.finished&&!this.finishCelebrated){
          this.finishCelebrated=true;
          this.slowMoUntil=time+1400;
          this.finishEmitter.emitParticleAt(mine.x,mine.y,90);
          this.time.delayedCall(120,()=>this.finishEmitter.emitParticleAt(mine.x,mine.y-20,40));
          this.time.delayedCall(280,()=>this.finishEmitter.emitParticleAt(mine.x+30,mine.y,35));
          this.cameras.main.flash(280,200,240,255,false);
          this.cameras.main.shake(420,0.014);
          this.cameras.main.zoomTo(Math.min(this.cameras.main.zoom*1.08,1.15),500,'Sine.easeOut',true);
        }
        const slowMo=time<this.slowMoUntil;
        this.visualTime+=delta*(slowMo?0.2:1);
        const visualTime=this.visualTime;
        const g=this.g;g.clear();
        // Twilight skyline with a glowing horizon
        g.fillGradientStyle(0x050b0d,0x0b1b20,0x14302d,0x1b3d36,1);
        g.fillRect(0,0,WORLD_WIDTH,WORLD_HEIGHT);
        for(let i=0;i<4;i++){
          const sunX=950+i*2700;
          g.fillStyle(0x68ffd5,0.045);g.fillCircle(sunX,270,250);
          g.fillStyle(0x68ffd5,0.035);g.fillCircle(sunX,270,190);
          g.fillStyle(0xffcf80,0.12);g.fillCircle(sunX,270,118);
          g.fillStyle(0xffd7a5,0.12);g.fillCircle(sunX,270,92);
          g.lineStyle(2,0x9dff9b,0.16);g.strokeCircle(sunX,270,124);
        }
        // Distant layered city silhouette and warm window lights
        for(let i=0;i<110;i++){
          const x=i*104;
          const height=70+((i*47)%150);
          const y=548-height;
          const width=62+((i*19)%35);
          g.fillStyle(i%3===0?0x193b3b:0x101f29,0.7);
          g.fillRect(x,y,width,height+100);
          g.fillStyle(i%4===0?0xffd479:0x68ffd5,0.38);
          for(let wy=y+15;wy<548;wy+=23){
            for(let wx=x+11;wx<x+width-5;wx+=18){
              if(((wx+wy+i*13)%5)!==0)g.fillRect(wx,wy,4,7);
            }
          }
        }
        // glittering stars
        for(let i=0;i<160;i++){
          const x=(i*197+Math.sin(visualTime/1200+i)*18)%WORLD_WIDTH;
          const y=20+(i*83)%330;
          g.fillStyle(0xffffff,0.18+((i%5)*0.12));g.fillCircle(x,y,i%3===0?2:1);
        }
        g.fillStyle(0x68ffd5,0.055);g.fillRect(0,530,WORLD_WIDTH,120);
        // Receding track grid beneath the race lane
        g.fillStyle(0x071216,0.82);g.fillRect(0,588,WORLD_WIDTH,132);
        g.lineStyle(1,0x68ffd5,0.18);
        for(let y=600;y<720;y+=24)g.lineBetween(0,y,WORLD_WIDTH,y);
        for(let x=0;x<=WORLD_WIDTH;x+=220)g.lineBetween(x,588,x-150,720);
        g.lineStyle(2,0x68ffd5,0.32);g.lineBetween(0,588,WORLD_WIDTH,588);
        // track line / finish
        const anchors=makeAnchors();
        anchors.forEach((a,i)=>{
          const pulse=1+Math.sin(visualTime/260+i)*.15;
          g.lineStyle(3,0x00e5ff,0.95);g.strokeCircle(a.x,a.y,10*pulse);
          g.fillStyle(0xffffff,1);g.fillCircle(a.x,a.y,3);
          if(i%6===0){g.fillStyle(0x7cff6b,1);g.fillRect(a.x-2,a.y+16,4,34)}
        });
        // Falling meteoroid rocks — colour & fall speed scale with current lap
        const nowSec=current?.startedAt
          ? Math.max(0,(Date.now()-current.startedAt)/1000)
          : visualTime/1000;
        const showerLap=mine?.lap??0;
        const colors=meteorColors(showerLap);
        for(let i=0;i<METEOR_COUNT;i++){
          const m=meteoroidAt(i,nowSec,showerLap);
          if(m.y<-40||m.y>WORLD_HEIGHT+40)continue;
          // faint trail upward
          g.lineStyle(3,colors.trail,0.35);
          g.lineBetween(m.x,m.y,m.x-4,m.y-28-(i%5)*4);
          g.lineStyle(1.5,colors.glow,0.55);
          g.lineBetween(m.x,m.y,m.x-2,m.y-18-(i%3)*3);
          // rocky body (irregular polygon)
          const rot=nowSec*1.4+i*0.9;
          const pts: {x:number;y:number}[]=[];
          for(let k=0;k<7;k++){
            const a=rot+k*(Math.PI*2/7);
            const rr=m.r*(0.72+(k%3)*0.14);
            pts.push({x:m.x+Math.cos(a)*rr,y:m.y+Math.sin(a)*rr});
          }
          g.fillStyle(colors.body,0.95);g.fillPoints(pts,true);
          g.lineStyle(1.5,colors.glow,0.7);g.strokePoints(pts,true);
          g.fillStyle(colors.core,0.85);g.fillCircle(m.x-m.r*0.15,m.y-m.r*0.1,m.r*0.35);
          // hot edge glow on later laps
          if(showerLap>=1){
            g.lineStyle(4,colors.glow,0.2);g.strokeCircle(m.x,m.y,m.r+3);
          }
        }
        // Collectible spirit cores: glowing pickups that award points.
        const collected = new Set(mine?.collectedOrbs || []);
        for (let i = 0; i < 17; i++) {
          if (collected.has(i)) continue;
          const orb = spiritOrbAt(i, nowSec);
          const pulse = 1 + Math.sin(visualTime / 110 + i) * 0.15;
          g.fillStyle(0x5cefff, 0.09); g.fillCircle(orb.x, orb.y, orb.r * 2.5 * pulse);
          g.lineStyle(2, 0xffd84f, 0.85); g.strokeCircle(orb.x, orb.y, orb.r * 1.45 * pulse);
          g.fillStyle(0x5cefff, 0.95); g.fillCircle(orb.x, orb.y, orb.r * 0.82 * pulse);
          g.fillStyle(0xffffff, 0.98); g.fillCircle(orb.x - 4, orb.y - 5, 4);
          g.fillStyle(0x7cff6b, 0.9); g.fillCircle(orb.x + 5, orb.y + 4, 3);
        }
        // Shield relics: one-hit protection pickups, shared deterministically with the server.
        const collectedShields = new Set(mine?.collectedShields || []);
        for (let i = 0; i < 8; i++) {
          if (collectedShields.has(i)) continue;
          const relic = shieldAt(i, nowSec);
          const pulse = 1 + Math.sin(visualTime / 125 + i) * 0.12;
          g.fillStyle(0x7cff6b, 0.08); g.fillCircle(relic.x, relic.y, relic.r * 2.4 * pulse);
          g.lineStyle(2, 0x9dff9b, 0.9); g.strokeCircle(relic.x, relic.y, relic.r * 1.45 * pulse);
          g.fillStyle(0x153b35, 0.98); g.fillCircle(relic.x, relic.y, relic.r * pulse);
          g.fillStyle(0x7cff6b, 0.98);
          g.fillPoints([{x:relic.x,y:relic.y-13},{x:relic.x+11,y:relic.y-7},{x:relic.x+9,y:relic.y+7},{x:relic.x,y:relic.y+13},{x:relic.x-9,y:relic.y+7},{x:relic.x-11,y:relic.y-7}], true);
          g.fillStyle(0xffffff, 0.95); g.fillCircle(relic.x-3, relic.y-4, 3);
        }
        // Energy mines: bright cores, warning rings, and rotating electric arcs.
        for (let i = 0; i < MINE_COUNT; i++) {
          const mine = mineAt(i, nowSec, showerLap);
          const pulse = 1 + Math.sin(visualTime / 95 + i) * 0.12;
          const spin = visualTime / 260 + i;
          g.fillStyle(0xff4fd8, 0.07); g.fillCircle(mine.x, mine.y, mine.r * 2.4 * pulse);
          g.lineStyle(2, 0xff78e8, 0.78); g.strokeCircle(mine.x, mine.y, mine.r * 1.55 * pulse);
          g.lineStyle(3, 0x5cefff, 0.9);
          g.beginPath();
          for (let arc = 0; arc < 3; arc++) {
            const a = spin + arc * (Math.PI * 2 / 3);
            const x1 = mine.x + Math.cos(a) * mine.r * 0.75;
            const y1 = mine.y + Math.sin(a) * mine.r * 0.75;
            const x2 = mine.x + Math.cos(a + 1.3) * mine.r * 1.35;
            const y2 = mine.y + Math.sin(a + 1.3) * mine.r * 1.35;
            g.lineBetween(x1, y1, x2, y2);
          }
          g.fillStyle(0x25123f, 1); g.fillCircle(mine.x, mine.y, mine.r * pulse);
          g.fillStyle(0xff4fd8, 0.95); g.fillCircle(mine.x, mine.y, mine.r * 0.56 * pulse);
          g.fillStyle(0xffffff, 0.95); g.fillCircle(mine.x - 3, mine.y - 4, 4);
        }
        // Framed lap / finish gate with a glowing threshold
        const gateGlow=0.08+Math.sin(visualTime/180)*0.025;
        g.fillStyle(0x46eaff,gateGlow);g.fillRect(10776,106,64,534);
        g.fillStyle(0x67f4ff,0.95);g.fillRect(10774,104,10,538);g.fillRect(10834,104,10,538);
        g.fillRect(10774,104,70,10);
        g.fillStyle(0xffffff,0.22+gateGlow);g.fillRect(10784,114,50,7);
        g.lineStyle(2,0xd6fbff,0.85);g.lineBetween(10784,114,10834,114);
        for(let y=0;y<640;y+=32){
          g.fillStyle((y/32)%2?0xffffff:0x160b32,1);g.fillRect(10800,y,16,32);
          g.fillStyle((y/32)%2?0x160b32:0xffffff,1);g.fillRect(10816,y,16,32);
        }
        g.fillStyle(0x7cf5ff,0.85);g.fillRect(10784,636,50,4);
        g.fillStyle(0xffffff,0.95);g.fillRect(10796,634,4,8);g.fillRect(10818,634,4,8);
        const laps=current?.totalLaps??TOTAL_LAPS;
        const myLap=mine?.lap??0;
        const onLast=!!mine?.finished||myLap>=laps-1;
        this.finishTitle.setText(onLast?'FINISH':`LAP ${Math.min(myLap+1,laps)}/${laps}`);
        this.finishTitle.setAlpha(0.78+Math.sin(visualTime/180)*0.2);
        g.fillStyle(0xffffff,1);
        // Phaser canvas has no dependable text drawing via graphics; label is separate below.
        const camera=this.cameras.main;
        // Keep the full vertical playfield visible in portrait. Landscape has
        // more horizontal room, so zoom into the playable band and trim empty sky.
        const portrait=window.matchMedia('(orientation: portrait)').matches;
        const framedWorldHeight=portrait?WORLD_HEIGHT/0.95:680;
        const fitZoom=this.scale.height/framedWorldHeight;
        const zoom=Math.max(0.25,Math.min(1.15,fitZoom));
        if(zoom>0&&Math.abs(camera.zoom-zoom)>0.001)camera.setZoom(zoom);
        if(mine){
          const cameraEase=1-Math.pow(1-(slowMo?0.025:0.12),delta/16.67);
          const visibleWorldWidth=this.scale.width/Math.max(camera.zoom,0.01);
          camera.scrollX=Phaser.Math.Linear(camera.scrollX,Math.max(0,mine.x-visibleWorldWidth*0.3),cameraEase);
          const visibleWorldHeight=this.scale.height/Math.max(camera.zoom,0.01);
          const targetY=Math.max(0,Math.min(WORLD_HEIGHT-visibleWorldHeight,mine.y-visibleWorldHeight*0.38));
          camera.scrollY=Phaser.Math.Linear(camera.scrollY,targetY,cameraEase*0.7);
        }
        const seen=new Set<string>();
        const players=current?.players||[];
        players.forEach(p=>{
          seen.add(p.id);
          if(p.attached&&p.anchorX!==null&&p.anchorY!==null){
            g.lineStyle(p.id===myId?3:2,p.id===myId?0xffffff:0xffd84f,0.95);
            g.lineBetween(p.x,p.y,p.anchorX,p.anchorY);
          }
          const bob=Math.sin(visualTime/155+p.x*0.013)*3.5;
          const overlapping=players.filter(other=>Math.hypot(other.x-p.x,other.y-p.y)<48);
          const overlapIndex=overlapping.findIndex(other=>other.id===p.id);
          const spacing=(overlapIndex-(overlapping.length-1)/2)*38;
          const ghostX=p.x+spacing+Math.sin(visualTime/380+p.y*0.02)*2;
          const ghostY=p.y+bob;
          const hem=(offset:number)=>Math.sin(visualTime/115+p.x*0.018+offset)*3;
          const robe=[
            {x:ghostX-17,y:ghostY-5},{x:ghostX-21,y:ghostY+10},
            {x:ghostX-19,y:ghostY+25},{x:ghostX-23,y:ghostY+32+hem(0)},
            {x:ghostX-12,y:ghostY+29+hem(1)},{x:ghostX-4,y:ghostY+34+hem(2)},
            {x:ghostX+5,y:ghostY+30+hem(3)},{x:ghostX+14,y:ghostY+34+hem(4)},
            {x:ghostX+23,y:ghostY+30+hem(5)},{x:ghostX+18,y:ghostY+18},
            {x:ghostX+17,y:ghostY-5}
          ];
          const online=p.connected!==false;
          const bodyA=online?0.98:0.45;
          const heroColor=Phaser.Display.Color.HexStringToColor(p.color || '#5cefff').color;
          // White sheet ghost with a rounded hood, rippling hem, and a bright team-color rim.
          if (p.shieldCharge) { g.lineStyle(2.5, 0x7cff6b, 0.9); g.strokeCircle(ghostX, ghostY + 1, 36 + Math.sin(visualTime / 90) * 2); g.fillStyle(0x7cff6b, 0.07); g.fillCircle(ghostX, ghostY + 1, 34); }
          const glow = 0.09 + Math.sin(visualTime / 130 + p.x * 0.01) * 0.025;
          g.fillStyle(heroColor, glow); g.fillCircle(ghostX, ghostY + 2, 37);
          const trail = Math.min(34, Math.abs(p.vx) * 0.018);
          g.lineStyle(5, 0xe8fdff, online ? 0.28 : 0.1);
          g.lineBetween(ghostX - 14, ghostY + 5, ghostX - 25 - trail, ghostY + 2);
          g.lineStyle(3, 0xe8fdff, online ? 0.58 : 0.2);
          g.lineBetween(ghostX - 13, ghostY + 16, ghostX - 24 - trail * 0.75, ghostY + 20);
          g.fillStyle(0xf1fdff, online ? 0.99 : 0.58); g.fillPoints(robe, true);
          g.fillEllipse(ghostX, ghostY - 11, 39, 43);
          g.fillStyle(0xbcefff, online ? 0.28 : 0.12); g.fillEllipse(ghostX, ghostY + 7, 18, 25);
          g.lineStyle(2.5, heroColor, online ? 0.95 : 0.38); g.strokePoints(robe, true);
          g.lineStyle(2, heroColor, online ? 0.9 : 0.35); g.strokeEllipse(ghostX, ghostY - 11, 39, 43);
          // Oversized midnight eyes and a tiny white glint keep the face readable at speed.
          g.fillStyle(0x5cefff, online ? 0.16 : 0.06); g.fillEllipse(ghostX, ghostY - 12, 27, 17);
          g.fillStyle(0x28304b, online ? 1 : 0.48);
          g.fillEllipse(ghostX - 7, ghostY - 12, 5, 8);
          g.fillEllipse(ghostX + 7, ghostY - 12, 5, 8);
          g.fillStyle(0xffffff, online ? 0.95 : 0.5);
          g.fillPoints([
            {x:ghostX,y:ghostY+2},{x:ghostX+3,y:ghostY+8},{x:ghostX+9,y:ghostY+9},
            {x:ghostX+4,y:ghostY+13},{x:ghostX+5,y:ghostY+19},{x:ghostX,y:ghostY+15},
            {x:ghostX-5,y:ghostY+19},{x:ghostX-4,y:ghostY+13},{x:ghostX-9,y:ghostY+9},
            {x:ghostX-3,y:ghostY+8}
          ], true);
          if(p.finished){g.fillStyle(0x7cff6b,1);g.fillCircle(ghostX,ghostY-42,7)}
          let label=this.labels.get(p.id);
          if(!label){label=this.add.text(p.x,p.y-54,'',{fontFamily:'Rubik, Arial',fontSize:'13px',fontStyle:'bold',color:'#ffffff',backgroundColor:'#170b39bb',padding:{x:5,y:3}}).setOrigin(.5);this.labels.set(p.id,label)}
          label.setPosition(ghostX,ghostY-48).setText(`${p.name}${p.id===myId?' ★':''}${p.rank?` #${p.rank}`:''}`);
        });
        for(const [id,label] of this.labels)if(!seen.has(id)){label.destroy();this.labels.delete(id)}
      }
    }
    const game=new Phaser.Game({type:Phaser.CANVAS,parent:hostRef.current,width:1100,height:640,
      backgroundColor:'#0b0827',render:{antialias:true},scale:{mode:Phaser.Scale.RESIZE,autoCenter:Phaser.Scale.CENTER_BOTH},scene:RushScene});
    // RESIZE gives the scene the stage's real dimensions; camera zoom is then
    // calculated from the viewport height so portrait doesn't stretch a landscape image.
    return()=>{sceneRef.current=null;game.destroy(true)};
  },[myId]);

  return <div className="canvas-shell">
    <div className="game-canvas" ref={hostRef}/>
    <div className="canvas-vignette"/>
    {state?.status==='finished'&&<div className={`finish-banner ${state.winner===myId?'winner':''}`}><span>{state.winner===myId?'👑 CHAMPION':'ALL LAPS DONE'}</span><strong>{state.winner===myId?'YOU WON!':'RACE OVER'}</strong></div>}
  </div>;
}
