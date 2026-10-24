import { useEffect, useRef } from 'react';
import Phaser from 'phaser';

export type PlayerState = {
  id: string; name: string; x: number; y: number; vx: number; vy: number;
  attached: boolean; anchorX: number | null; anchorY: number | null;
  finished: boolean; eliminated?: boolean; rank: number | null; score: number; finishTime: number | null; color: string;
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
const BOMB_COUNT = 5;
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

/** Random-looking bomb paths, deterministic and matched by the server. */
const bombAt = (i: number, now: number) => {
  const seed = i + 1;
  const randomX = ((seed * 1103515245 + 12345) % 2147483647) / 2147483647;
  const randomY = ((seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const randomMotion = ((seed * 22695477 + 1) % 4294967296) / 4294967296;
  const phase = Math.PI * 2;
  const baseX = 850 + i * ((FINISH_X - 1700) / (BOMB_COUNT - 1)) + (randomX - 0.5) * 240;
  const baseY = 105 + randomY * 360;
  return {
    x: baseX + Math.sin(now * (0.35 + randomMotion * 0.3) + randomY * phase) * (70 + randomX * 80),
    y: baseY + Math.cos(now * (0.55 + randomX * 0.35) + randomMotion * phase) * (28 + randomY * 42),
    r: 21 + randomMotion * 4,
  };
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
          fontSize:'17px',
          fontStyle:'bold',
          color:'#e4d9ff',
          stroke:'#111321',
          strokeThickness:4,
          shadow:{color:'#9b7bff',blur:16,fill:true},
          letterSpacing:1
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
        // Sling anchors and lap checkpoints
        const anchors=makeAnchors();
        anchors.forEach((a,i)=>{
          const pulse=1+Math.sin(visualTime/260+i)*.15;
          g.fillStyle(0x9e8cff,0.08);g.fillCircle(a.x,a.y,15*pulse);
          g.lineStyle(i%6===0?2.5:1.5,i%6===0?0xc6b7ff:0x8ce9f0,i%6===0?0.82:0.62);
          g.strokeCircle(a.x,a.y,(i%6===0?9:7)*pulse);
          g.fillStyle(0xf3f0ff,i%6===0?0.95:0.78);g.fillCircle(a.x,a.y,i%6===0?2.6:2);
          if(i%6===0){
            g.lineStyle(2,0xbba8ff,0.48);
            g.lineBetween(a.x-15,a.y+17,a.x+15,a.y+17);
            g.fillStyle(0xc9bcff,0.78);
            g.fillCircle(a.x-15,a.y+17,1.8);g.fillCircle(a.x+15,a.y+17,1.8);
          }
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
        // Rare ember bombs: obsidian casing, molten seams, and a sparking fuse.
        for (let i = 0; i < BOMB_COUNT; i++) {
          const bomb = bombAt(i, nowSec);
          const pulse = 1 + Math.sin(visualTime / 180 + i * 2) * 0.08;
          const ember = 0.68 + (Math.sin(visualTime / 52 + i * 2) + 1) * 0.16;
          g.fillStyle(0xff633d, 0.065); g.fillCircle(bomb.x, bomb.y, bomb.r * 2.2 * pulse);
          g.lineStyle(1.5, 0xff835e, 0.42 + pulse * 0.12); g.strokeCircle(bomb.x, bomb.y, bomb.r * 1.48 * pulse);

          // Heavy metal collar and a jagged, animated ember fuse.
          g.fillStyle(0x82766f, 1);
          g.fillPoints([
            {x:bomb.x-8,y:bomb.y-16},{x:bomb.x-6,y:bomb.y-22},
            {x:bomb.x+5,y:bomb.y-22},{x:bomb.x+8,y:bomb.y-15},
          ], true);
          g.lineStyle(3, 0xff9b52, 0.95); g.lineBetween(bomb.x + 4, bomb.y - 20, bomb.x + 9, bomb.y - 28);
          g.lineStyle(2, 0xffd278, ember); g.lineBetween(bomb.x + 9, bomb.y - 28, bomb.x + 14, bomb.y - 31);
          g.fillStyle(0xff7a3d, ember); g.fillPoints([
            {x:bomb.x+13,y:bomb.y-31},{x:bomb.x+15,y:bomb.y-38},
            {x:bomb.x+18,y:bomb.y-33},{x:bomb.x+23,y:bomb.y-34},
            {x:bomb.x+19,y:bomb.y-29},{x:bomb.x+20,y:bomb.y-25},
          ], true);
          g.fillStyle(0xffedb0, ember); g.fillCircle(bomb.x + 17, bomb.y - 32, 2);

          // Charcoal sphere with bright lava fractures and a hard specular glint.
          g.fillStyle(0x21181b, 1); g.fillCircle(bomb.x, bomb.y, bomb.r * pulse);
          g.fillStyle(0x382126, 0.9); g.fillCircle(bomb.x - 2, bomb.y - 3, bomb.r * 0.72 * pulse);
          g.lineStyle(2, 0xc66b50, 0.88); g.strokeCircle(bomb.x, bomb.y, bomb.r * pulse);
          g.fillStyle(0xffddbd, 0.32); g.fillEllipse(bomb.x - 7, bomb.y - 10, 8, 4);
          g.lineStyle(2, 0xff7548, 0.95);
          g.lineBetween(bomb.x - 3, bomb.y - 17, bomb.x - 8, bomb.y - 8);
          g.lineBetween(bomb.x - 8, bomb.y - 8, bomb.x - 3, bomb.y - 3);
          g.lineBetween(bomb.x + 7, bomb.y - 2, bomb.x + 2, bomb.y + 5);
          g.lineBetween(bomb.x + 2, bomb.y + 5, bomb.x + 9, bomb.y + 13);
          g.lineStyle(1, 0xffc57a, 0.9);
          g.lineBetween(bomb.x - 15, bomb.y + 2, bomb.x - 11, bomb.y + 2);
          g.lineBetween(bomb.x + 11, bomb.y - 10, bomb.x + 14, bomb.y - 10);
        }
        // A slim moonlit arch and refined checker stripe mark each lap's threshold.
        const gatePulse=0.7+Math.sin(visualTime/240)*0.12;
        g.fillStyle(0x9b7bff,0.035+gatePulse*0.025);g.fillRect(10790,118,20,470);
        g.fillStyle(0x9b7bff,0.13);g.fillRect(10778,104,8,484);g.fillRect(10814,104,8,484);
        g.fillStyle(0xc8b8ff,0.78);g.fillRect(10780,104,40,3);
        g.fillStyle(0xffffff,0.7);g.fillRect(10782,108,36,1);
        g.lineStyle(1.5,0xc6b7ff,0.62+gatePulse*0.2);
        g.lineBetween(10788,112,10788,588);g.lineBetween(10812,112,10812,588);
        g.lineStyle(2,0xb8f3f1,0.58+gatePulse*0.2);g.lineBetween(10800,112,10800,588);
        for(let y=0;y<588;y+=20){
          const alternate=(y/20)%2===0;
          g.fillStyle(alternate?0xe9e2ff:0x20203a,alternate?0.88:0.94);
          g.fillRect(10794,y,6,10);
          g.fillStyle(alternate?0x20203a:0xe9e2ff,alternate?0.94:0.88);
          g.fillRect(10794,y+10,6,10);
        }
        const laps=current?.totalLaps??TOTAL_LAPS;
        const myLap=mine?.lap??0;
        const onLast=!!mine?.finished||myLap>=laps-1;
        this.finishTitle.setText(onLast?'FINISH':`LAP ${Math.min(myLap+1,laps)}/${laps}`);
        this.finishTitle.setAlpha(0.78+Math.sin(visualTime/180)*0.2);
        g.fillStyle(0xffffff,1);
        // Phaser canvas has no dependable text drawing via graphics; label is separate below.
        const camera=this.cameras.main;
        // Frame the playable band for the game's landscape layout.
        const fitZoom=this.scale.height/680;
        const zoom=Math.max(0.25,Math.min(1.15,fitZoom));
        if(zoom>0&&Math.abs(camera.zoom-zoom)>0.001)camera.setZoom(zoom);
        if(mine){
          const cameraEase=1-Math.pow(1-(slowMo?0.025:0.12),delta/16.67);
          const visibleWorldWidth=this.scale.width/Math.max(camera.zoom,0.01);
          camera.scrollX=Phaser.Math.Linear(camera.scrollX,Math.max(0,mine.x-visibleWorldWidth*0.3),cameraEase);
        }
        // Keep the vertical camera fixed so spawning and respawning don't look
        // like the ghost suddenly jumps as the camera catches up.
        camera.scrollY=0;
        const seen=new Set<string>();
        const players=(current?.players||[]).filter(p=>!p.eliminated);
        players.forEach(p=>{
          seen.add(p.id);
          if(p.attached&&p.anchorX!==null&&p.anchorY!==null){
            g.lineStyle(p.id===myId?3:2,p.id===myId?0xffffff:0xffd84f,0.95);
            g.lineBetween(p.x,p.y,p.anchorX,p.anchorY);
          }
          const overlapping=players.filter(other=>Math.hypot(other.x-p.x,other.y-p.y)<48);
          const overlapIndex=overlapping.findIndex(other=>other.id===p.id);
          const spacing=(overlapIndex-(overlapping.length-1)/2)*38;
          const ghostX=p.x+spacing+Math.sin(visualTime/380+p.y*0.02)*2;
          const ghostY=p.y;
          const heroColor=Phaser.Display.Color.HexStringToColor(p.color || '#5cefff').color;
          const wave=visualTime/180+p.x*.018;
          const robe=[{x:ghostX-17,y:ghostY-4}];
          for(let i=0;i<=16;i++){
            const angle=Math.PI-i*Math.PI/16;
            robe.push({x:ghostX+Math.cos(angle)*17,y:ghostY-4-Math.sin(angle)*20});
          }
          robe.push({x:ghostX+18,y:ghostY+17});
          for(let i=0;i<=24;i++){
            const t=i/24;
            const x=ghostX+18-t*36;
            const y=ghostY+26+Math.sin(t*Math.PI*4+wave)*2.2;
            robe.push({x,y});
          }
          robe.push({x:ghostX-18,y:ghostY+17});
          // Layer a soft team-color aura behind a smooth, rippling sheet silhouette.
          g.fillStyle(heroColor,0.11+Math.sin(visualTime/170+p.x*.01)*0.025);
          g.fillCircle(ghostX,ghostY+2,39);
          if (p.shieldCharge) { g.lineStyle(2.5, 0x7cff6b, 0.9); g.strokeCircle(ghostX, ghostY + 1, 36 + Math.sin(visualTime / 90) * 2); g.fillStyle(0x7cff6b, 0.07); g.fillCircle(ghostX, ghostY + 1, 34); }
          const trail = Math.min(34, Math.abs(p.vx) * 0.018);
          g.lineStyle(2.5,heroColor,0.3);
          g.lineBetween(ghostX-17,ghostY+4,ghostX-27-trail,ghostY+1);
          g.lineStyle(1.5,0xe8fdff,0.32);
          g.lineBetween(ghostX-16,ghostY+15,ghostX-24-trail*.72,ghostY+18);
          g.fillStyle(0xf7fdff,0.98); g.fillPoints(robe,true);
          g.fillStyle(heroColor,0.16); g.fillEllipse(ghostX,ghostY+8,22,27);
          g.lineStyle(2.5,heroColor,0.96); g.strokePoints(robe,true);
          // Bright, oversized eyes and tiny highlights make the face readable at speed.
          g.fillStyle(0x293047,1);
          g.fillEllipse(ghostX-7,ghostY-9,6,10);
          g.fillEllipse(ghostX+7,ghostY-9,6,10);
          g.fillStyle(0xffffff,0.98);
          g.fillCircle(ghostX-8,ghostY-11,1.5);
          g.fillCircle(ghostX+6,ghostY-11,1.5);
          g.fillStyle(heroColor,0.34);
          g.fillEllipse(ghostX-13,ghostY+1,5,3);
          g.fillEllipse(ghostX+13,ghostY+1,5,3);
          // A small four-point star gives each racer a bright signature mark.
          g.fillStyle(0xffffff,0.88);
          g.fillPoints([
            {x:ghostX,y:ghostY+7},{x:ghostX+2,y:ghostY+11},{x:ghostX+6,y:ghostY+13},
            {x:ghostX+2,y:ghostY+15},{x:ghostX,y:ghostY+19},{x:ghostX-2,y:ghostY+15},
            {x:ghostX-6,y:ghostY+13},{x:ghostX-2,y:ghostY+11}
          ],true);
          g.lineStyle(1.5,heroColor,0.58);
          g.strokeEllipse(ghostX,ghostY-27,17,5);
          g.fillStyle(heroColor,0.95);
          g.fillCircle(ghostX,ghostY-30,2.5);
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
    // calculated from the viewport height for the landscape race layout.
    return()=>{sceneRef.current=null;game.destroy(true)};
  },[myId]);

  return <div className="canvas-shell">
    <div className="game-canvas" ref={hostRef}/>
    <div className="canvas-vignette"/>
    {state?.status==='finished'&&<div className={`finish-banner ${state.winner===myId?'winner':''}`}><span>{state.winner===myId?'👑 CHAMPION':'ALL LAPS DONE'}</span><strong>{state.winner===myId?'YOU WON!':'RACE OVER'}</strong></div>}
  </div>;
}
