"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { deleteMidi, loadMidi, MidiHistoryItem, MidiStep, parseMidiFile, saveMidi } from "./midi";

type Song = { id: string; title: string; subtitle: string; level: string; bpm: number; steps: MidiStep[] };
const BLACK = new Set([1, 3, 6, 8, 10]);
const HISTORY_COOKIE = "pianote_midi_history";
const LOOKAHEAD_BEATS = 8;
const SPEEDS = [0.25, 0.5, 0.75, 1] as const;

function sequence(midis: number[], longAt: number[] = []): MidiStep[] {
  return midis.map((midi, index) => ({ start: index, tones: [{ midi, duration: longAt.includes(index) ? 1.9 : 0.82 }] }));
}

const SONGS: Song[] = [
  { id:"ode",title:"환희의 송가",subtitle:"베토벤",level:"입문",bpm:92,steps:sequence([64,64,65,67,67,65,64,62,60,60,62,64,64,62,62],[6,14]) },
  { id:"twinkle",title:"작은 별",subtitle:"프랑스 전래곡",level:"입문",bpm:88,steps:sequence([60,60,67,67,69,69,67,65,65,64,64,62,62,60],[6,13]) },
  { id:"mary",title:"메리의 작은 양",subtitle:"미국 전래곡",level:"입문",bpm:96,steps:sequence([64,62,60,62,64,64,64,62,62,62,64,67,67],[6,9,12]) },
  { id:"jingle",title:"징글벨",subtitle:"제임스 피어폰트",level:"초급",bpm:104,steps:sequence([64,64,64,64,64,64,64,67,60,62,64,65,65,65,65,65,64,64,64,64,62,62,64,62,67],[2,5,10,14,24]) },
  { id:"frere",title:"자크 형제",subtitle:"프랑스 전래곡",level:"초급",bpm:96,steps:sequence([60,62,64,60,60,62,64,60,64,65,67,64,65,67],[3,7,10,13]) },
  { id:"scale",title:"다장조 음계",subtitle:"기초 손가락 연습",level:"연습",bpm:80,steps:sequence([60,62,64,65,67,69,71,72,71,69,67,65,64,62,60],[7,14]) },
];

function midiName(midi: number) {
  const names = ["C","C♯","D","D♯","E","F","F♯","G","G♯","A","A♯","B"];
  return `${names[midi % 12]}${Math.floor(midi / 12) - 1}`;
}
function readHistory(): MidiHistoryItem[] {
  if (typeof document === "undefined") return [];
  const value = document.cookie.split("; ").find((part) => part.startsWith(`${HISTORY_COOKIE}=`))?.split("=").slice(1).join("=");
  try { return value ? JSON.parse(decodeURIComponent(value)) : []; } catch { return []; }
}
function writeHistory(items: MidiHistoryItem[]) {
  document.cookie = `${HISTORY_COOKIE}=${encodeURIComponent(JSON.stringify(items.slice(0,8)))}; Max-Age=31536000; Path=/; SameSite=Lax; Secure`;
}
function keyCenter(midi: number, keys: number[]) {
  const whites = keys.filter((key) => !BLACK.has(key % 12));
  const width = 100 / whites.length;
  return BLACK.has(midi % 12)
    ? keys.filter((key) => key < midi && !BLACK.has(key % 12)).length * width
    : (Math.max(0, whites.indexOf(midi)) + 0.5) * width;
}

export default function Home() {
  const [songId,setSongId] = useState(SONGS[0].id);
  const [customSongs,setCustomSongs] = useState<Song[]>([]);
  const [history,setHistory] = useState<MidiHistoryItem[]>([]);
  const [importError,setImportError] = useState("");
  const [isImporting,setIsImporting] = useState(false);
  const [speed,setSpeed] = useState<(typeof SPEEDS)[number]>(0.5);
  const [playhead,setPlayhead] = useState(0);
  const [playing,setPlaying] = useState(false);
  const [currentIndex,setCurrentIndex] = useState(0);
  const playheadRef = useRef(0);
  const viewportRef = useRef<HTMLDivElement>(null);
  const allSongs = [...SONGS,...customSongs];
  const song = allSongs.find((item) => item.id === songId) ?? SONGS[0];

  useEffect(() => setHistory(readHistory()), []);
  const totalBeats = useMemo(() => Math.max(...song.steps.flatMap((step) => step.tones.map((tone) => step.start + tone.duration)),1),[song]);
  const songPitches = useMemo(() => song.steps.flatMap((step) => step.tones.map((tone) => tone.midi)),[song]);
  const lowest = Math.min(...songPitches), highest = Math.max(...songPitches);
  const keyboardStart = lowest - (lowest % 12);
  const keyboardEnd = Math.max(keyboardStart + 12, highest + ((12 - highest % 12) % 12));
  const keyboardKeys = Array.from({length:keyboardEnd-keyboardStart+1},(_,i)=>keyboardStart+i);
  const whiteCount = keyboardKeys.filter((key)=>!BLACK.has(key%12)).length;
  const surfaceWidth = Math.max(720,whiteCount*42);

  useEffect(() => {
    if (!playing) return;
    let frame = 0, previous = performance.now();
    const animate = (now:number) => {
      const delta = Math.min(0.08,(now-previous)/1000); previous = now;
      const next = playheadRef.current + delta * (song.bpm/60) * speed;
      playheadRef.current = next; setPlayhead(next);
      let nextIndex = song.steps.findIndex((step)=>step.start>next);
      nextIndex = nextIndex < 0 ? song.steps.length-1 : Math.max(0,nextIndex-1);
      setCurrentIndex(nextIndex);
      if (next >= totalBeats + 0.5) { setPlaying(false); return; }
      frame=requestAnimationFrame(animate);
    };
    frame=requestAnimationFrame(animate);
    return ()=>cancelAnimationFrame(frame);
  },[playing,song,speed,totalBeats]);

  useEffect(() => {
    const viewport=viewportRef.current, step=song.steps[currentIndex];
    if (!viewport||!step) return;
    const center=keyCenter(step.tones[step.tones.length-1].midi,keyboardKeys)/100*surfaceWidth;
    const left=viewport.scrollLeft,right=left+viewport.clientWidth;
    if (center<left+80||center>right-80) viewport.scrollTo({left:Math.max(0,center-viewport.clientWidth/2),behavior:"smooth"});
  },[currentIndex,songId,surfaceWidth]);

  function resetPlayer(){ setPlaying(false);playheadRef.current=0;setPlayhead(0);setCurrentIndex(0); }
  function selectSong(next:Song){ resetPlayer();setSongId(next.id); }
  function togglePlay(){ if(playhead>=totalBeats){resetPlayer();setTimeout(()=>setPlaying(true),0);}else setPlaying((value)=>!value); }

  async function importBuffer(buffer:ArrayBuffer,filename:string,existingId?:string){
    setIsImporting(true);setImportError("");
    try{
      const parsed=parseMidiFile(buffer,filename),id=existingId??`${Date.now().toString(36)}-${buffer.byteLength.toString(36)}`;
      await saveMidi(id,buffer);
      const item:MidiHistoryItem={id,name:filename.slice(0,80),title:parsed.title.slice(0,60),noteCount:parsed.steps.length,importedAt:Date.now()};
      const nextHistory=[item,...history.filter((entry)=>entry.id!==id)].slice(0,8);setHistory(nextHistory);writeHistory(nextHistory);
      const nextSong:Song={id:`midi-${id}`,title:parsed.title,subtitle:"내 MIDI · 기기 내 저장",level:"MIDI",bpm:parsed.bpm,steps:parsed.steps};
      setCustomSongs((songs)=>[...songs.filter((entry)=>entry.id!==nextSong.id),nextSong]);selectSong(nextSong);
    }catch(error){setImportError(error instanceof Error?error.message:"MIDI 파일을 읽지 못했습니다.");}finally{setIsImporting(false);}
  }
  async function handleMidiFile(event:React.ChangeEvent<HTMLInputElement>){const file=event.target.files?.[0];if(file)await importBuffer(await file.arrayBuffer(),file.name||"내 MIDI.mid");event.target.value="";}
  async function reopenMidi(item:MidiHistoryItem){const buffer=await loadMidi(item.id);if(buffer)await importBuffer(buffer,item.name,item.id);else setImportError("저장된 파일을 찾지 못했습니다. 다시 불러와 주세요.");}
  async function removeHistory(item:MidiHistoryItem){await deleteMidi(item.id);const next=history.filter((entry)=>entry.id!==item.id);setHistory(next);writeHistory(next);setCustomSongs((songs)=>songs.filter((entry)=>entry.id!==`midi-${item.id}`));if(songId===`midi-${item.id}`)selectSong(SONGS[0]);}

  const visibleSteps=song.steps.filter((step)=>step.start+Math.max(...step.tones.map((tone)=>tone.duration))>=playhead-0.5&&step.start<=playhead+LOOKAHEAD_BEATS);
  const current=song.steps[currentIndex];
  return <main>
    <header className="topbar"><a className="brand" href="#"><span>p</span>Pianote</a><div className="now-playing"><small>NOW PRACTICING</small><strong>{song.title}</strong></div><button className="reset-button" onClick={resetPlayer} aria-label="처음부터">↺</button></header>
    <section className="library">
      <div className="section-title"><span>연습곡</span><strong>{allSongs.length} TRACKS</strong></div>
      <div className="song-list">{allSongs.map((item,i)=><button key={item.id} className={`song-card ${item.id===song.id?"selected":""}`} onClick={()=>selectSong(item)}><span>{String(i+1).padStart(2,"0")}</span><div><strong>{item.title}</strong><small>{item.subtitle} · {item.bpm} BPM</small></div><em>{item.level}</em></button>)}
        <label className="import-card"><input type="file" accept="*/*" onChange={handleMidiFile} disabled={isImporting}/><b>+</b><div><strong>{isImporting?"불러오는 중…":"내 MIDI"}</strong><small>기기에만 저장</small></div></label>
      </div>
      {history.length>0&&<div className="history"><span>최근</span>{history.map((item)=><div key={item.id}><button onClick={()=>reopenMidi(item)}>{item.title}</button><button onClick={()=>removeHistory(item)} aria-label="삭제">×</button></div>)}</div>}{importError&&<p className="error">{importError}</p>}
    </section>
    <section className="game-shell">
      <div className="game-toolbar"><div><small>SPEED</small>{SPEEDS.map((value)=><button key={value} className={speed===value?"selected":""} onClick={()=>setSpeed(value)}>{value}×</button>)}</div><div className="timeline"><i style={{width:`${Math.min(100,playhead/totalBeats*100)}%`}}/><span>{Math.min(song.steps.length,currentIndex+1)} / {song.steps.length}</span></div><button className={`play-button ${playing?"playing":""}`} onClick={togglePlay}>{playing?"❚❚ 일시정지":"▶ 재생"}</button></div>
      <div className="roll-viewport" ref={viewportRef}><div className="roll-surface" style={{width:surfaceWidth}}>
        <div className="piano-roll">{Array.from({length:whiteCount},(_,i)=><i className="lane" key={i} style={{left:`${i/whiteCount*100}%`,width:`${100/whiteCount}%`}}/>)}
          {visibleSteps.flatMap((step)=>step.tones.map((tone)=>{const bottom=18+(step.start-playhead)/LOOKAHEAD_BEATS*82;const height=Math.max(22,tone.duration/LOOKAHEAD_BEATS*82*5.25);return <div key={`${step.start}-${tone.midi}`} className={`note-bar ${tone.midi<60?"left":"right"}`} style={{left:`calc(${keyCenter(tone.midi,keyboardKeys)}% - 16px)`,bottom:`${bottom}%`,height}}><span>{midiName(tone.midi).replace(/\d/,"")}</span></div>}))}
          <div className="hit-line"><span>PLAY</span></div>
        </div>
        <div className="keyboard">{keyboardKeys.filter((midi)=>!BLACK.has(midi%12)).map((midi)=><div key={midi} className={`white-key ${current?.tones.some((tone)=>tone.midi===midi)?"target":""}`}><span>{midiName(midi)}</span></div>)}{keyboardKeys.filter((midi)=>BLACK.has(midi%12)).map((midi)=>{const before=keyboardKeys.filter((key)=>key<midi&&!BLACK.has(key%12)).length,w=100/whiteCount;return <div key={midi} className={`black-key ${current?.tones.some((tone)=>tone.midi===midi)?"target":""}`} style={{left:`${before*w-w*.28}%`,width:`${w*.56}%`}}><span>{midiName(midi)}</span></div>})}</div>
      </div></div>
      <div className="chord-readout"><small>{current?.tones.length>1?"양손 화음":"현재 노트"}</small><strong>{current?.tones.map((tone)=>midiName(tone.midi)).join("  +  ")}</strong><span>{Math.round(song.bpm*speed)} BPM</span></div>
    </section>
    <footer>마이크 인식 없이 재생 속도에 맞춰 연주하세요. MIDI의 음 길이와 양손 화음이 그대로 표시됩니다.</footer>
  </main>;
}
