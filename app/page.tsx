"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Note = { midi: number; name: string; hand: "R" | "L" };
type Song = { id: string; title: string; subtitle: string; level: string; notes: Note[] };

const makeNotes = (midis: number[]): Note[] => midis.map((midi) => ({ midi, name: midiName(midi), hand: "R" }));

const SONGS: Song[] = [
  { id: "ode", title: "환희의 송가", subtitle: "베토벤", level: "입문", notes: makeNotes([64,64,65,67,67,65,64,62,60,60,62,64,64,62,62]) },
  { id: "twinkle", title: "작은 별", subtitle: "프랑스 전래곡", level: "입문", notes: makeNotes([60,60,67,67,69,69,67,65,65,64,64,62,62,60]) },
  { id: "mary", title: "메리의 작은 양", subtitle: "미국 전래곡", level: "입문", notes: makeNotes([64,62,60,62,64,64,64,62,62,62,64,67,67]) },
  { id: "jingle", title: "징글벨", subtitle: "제임스 피어폰트", level: "초급", notes: makeNotes([64,64,64,64,64,64,64,67,60,62,64,65,65,65,65,65,64,64,64,64,62,62,64,62,67]) },
  { id: "frere", title: "자크 형제", subtitle: "프랑스 전래곡", level: "초급", notes: makeNotes([60,62,64,60,60,62,64,60,64,65,67,64,65,67]) },
  { id: "scale", title: "다장조 음계", subtitle: "기초 손가락 연습", level: "연습", notes: makeNotes([60,62,64,65,67,69,71,72,71,69,67,65,64,62,60]) },
];

const KEYS = Array.from({ length: 13 }, (_, i) => 60 + i);
const BLACK = new Set([1, 3, 6, 8, 10]);

function midiName(midi: number) {
  const names = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
  return `${names[midi % 12]}${Math.floor(midi / 12) - 1}`;
}

function frequencyToMidi(frequency: number) {
  return Math.round(69 + 12 * Math.log2(frequency / 440));
}

function autoCorrelate(buffer: Float32Array, sampleRate: number) {
  let rms = 0;
  for (const value of buffer) rms += value * value;
  rms = Math.sqrt(rms / buffer.length);
  if (rms < 0.018) return { frequency: -1, clarity: 0, level: rms };

  const minLag = Math.floor(sampleRate / 1050);
  const maxLag = Math.min(Math.floor(sampleRate / 60), buffer.length - 1);
  let bestLag = -1;
  let best = 0;

  for (let lag = minLag; lag <= maxLag; lag++) {
    let correlation = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < buffer.length - lag; i += 2) {
      correlation += buffer[i] * buffer[i + lag];
      normA += buffer[i] * buffer[i];
      normB += buffer[i + lag] * buffer[i + lag];
    }
    const normalized = correlation / Math.sqrt(normA * normB || 1);
    if (normalized > best) {
      best = normalized;
      bestLag = lag;
    }
  }

  return {
    frequency: bestLag > 0 && best > 0.72 ? sampleRate / bestLag : -1,
    clarity: best,
    level: rms,
  };
}

export default function Home() {
  const [songId, setSongId] = useState(SONGS[0].id);
  const [index, setIndex] = useState(0);
  const [micState, setMicState] = useState<"idle" | "listening" | "error">("idle");
  const [heardMidi, setHeardMidi] = useState<number | null>(null);
  const [level, setLevel] = useState(0);
  const [message, setMessage] = useState("마이크를 켜고 첫 음 E4를 연주하세요");
  const [completed, setCompleted] = useState(false);
  const audioRef = useRef<{ context: AudioContext; stream: MediaStream; frame: number } | null>(null);
  const stableRef = useRef({ midi: -1, count: 0, lastAdvance: 0 });
  const indexRef = useRef(index);
  indexRef.current = index;
  const song = SONGS.find((item) => item.id === songId) ?? SONGS[0];

  const acceptNote = useCallback((midi: number, source: "mic" | "key" = "mic") => {
    if (completed) return;
    const expected = song.notes[indexRef.current].midi;
    setHeardMidi(midi);
    if (midi !== expected) {
      setMessage(`${midiName(midi)}가 들려요 · ${midiName(expected)}를 연주해 보세요`);
      return;
    }

    const now = performance.now();
    if (source === "mic") {
      const stable = stableRef.current;
      stable.count = stable.midi === midi ? stable.count + 1 : 1;
      stable.midi = midi;
      if (stable.count < 3 || now - stable.lastAdvance < 450) return;
      stable.lastAdvance = now;
      stable.count = 0;
    }

    const next = indexRef.current + 1;
    if (next >= song.notes.length) {
      setCompleted(true);
      setMessage(`연주 완료! ${song.title}을(를) 끝까지 연주했어요.`);
    } else {
      indexRef.current = next;
      setIndex(next);
      setMessage(`좋아요! 다음 음은 ${song.notes[next].name}`);
    }
  }, [completed, song]);

  const stopMic = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    cancelAnimationFrame(audio.frame);
    audio.stream.getTracks().forEach((track) => track.stop());
    void audio.context.close();
    audioRef.current = null;
    setMicState("idle");
  }, []);

  useEffect(() => () => stopMic(), [stopMic]);

  async function startMic() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      const context = new AudioContext({ latencyHint: "interactive" });
      await context.resume();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 4096;
      analyser.smoothingTimeConstant = 0;
      source.connect(analyser);
      const data = new Float32Array(analyser.fftSize);
      const audio = { context, stream, frame: 0 };
      audioRef.current = audio;
      setMicState("listening");
      setMessage(`${song.notes[indexRef.current].name}를 연주해 보세요`);

      let lastAnalysis = 0;
      const analyse = (time: number) => {
        if (!audioRef.current) return;
        if (time - lastAnalysis > 45) {
          analyser.getFloatTimeDomainData(data);
          const result = autoCorrelate(data, context.sampleRate);
          setLevel(Math.min(1, result.level * 12));
          if (result.frequency > 0) acceptNote(frequencyToMidi(result.frequency));
          lastAnalysis = time;
        }
        audio.frame = requestAnimationFrame(analyse);
      };
      audio.frame = requestAnimationFrame(analyse);
    } catch {
      setMicState("error");
      setMessage("마이크를 사용할 수 없어요. 브라우저 권한을 확인해 주세요.");
    }
  }

  function reset() {
    indexRef.current = 0;
    stableRef.current = { midi: -1, count: 0, lastAdvance: 0 };
    setIndex(0);
    setCompleted(false);
    setHeardMidi(null);
    const firstNote = song.notes[0].name;
    setMessage(micState === "listening" ? `${firstNote}를 연주해 보세요` : `마이크를 켜고 첫 음 ${firstNote}를 연주하세요`);
  }

  function selectSong(nextSong: Song) {
    stopMic();
    setSongId(nextSong.id);
    indexRef.current = 0;
    stableRef.current = { midi: -1, count: 0, lastAdvance: 0 };
    setIndex(0);
    setCompleted(false);
    setHeardMidi(null);
    setLevel(0);
    setMessage(`마이크를 켜고 첫 음 ${nextSong.notes[0].name}를 연주하세요`);
  }

  const current = song.notes[index];
  const visibleNotes = song.notes.slice(index, index + 6);

  return (
    <main>
      <header className="topbar">
        <a className="brand" href="#" aria-label="Pianote 홈"><span>p</span>Pianote</a>
        <div className="lesson-pill">{song.level} <b>·</b> {song.title}</div>
        <button className="icon-button" onClick={reset} aria-label="연습 다시 시작">↻</button>
      </header>

      <nav className="song-library" aria-label="연습곡 선택">
        <div className="library-heading"><span>연습곡</span><strong>{SONGS.length}곡</strong></div>
        <div className="song-list">
          {SONGS.map((item, songIndex) => (
            <button key={item.id} className={`song-card ${item.id === song.id ? "selected" : ""}`} onClick={() => selectSong(item)} aria-pressed={item.id === song.id}>
              <span className="song-number">{String(songIndex + 1).padStart(2, "0")}</span>
              <span className="song-info"><strong>{item.title}</strong><small>{item.subtitle} · {item.notes.length}음</small></span>
              <em>{item.level}</em>
            </button>
          ))}
        </div>
      </nav>

      <section className="practice" aria-live="polite">
        <div className="progress-row">
          <span>{completed ? "완료" : `${index + 1}번째 음`}</span>
          <div className="progress"><i style={{ width: `${completed ? 100 : ((index + 1) / song.notes.length) * 100}%` }} /></div>
          <strong>{completed ? song.notes.length : index + 1} / {song.notes.length}</strong>
        </div>

        <div className="falling-stage">
          <div className="staff-lines" />
          {visibleNotes.map((note, position) => {
            const whiteIndex = KEYS.filter((key) => !BLACK.has(key % 12)).indexOf(note.midi);
            return (
              <div
                className={`falling-note ${position === 0 ? "active" : ""}`}
                key={`${index}-${position}`}
                style={{ left: `calc(${Math.max(0, whiteIndex) * 12.5 + 6.25}% - 17px)`, bottom: `${position * 78 + 30}px` }}
              >
                <span>{note.name.replace(/\d/, "")}</span>
              </div>
            );
          })}
          <div className="target-line"><span>여기서 연주</span></div>
        </div>

        <div className="keyboard" aria-label="테스트용 피아노 건반">
          {KEYS.filter((midi) => !BLACK.has(midi % 12)).map((midi) => (
            <button key={midi} className={`white-key ${current.midi === midi ? "target" : ""}`} onClick={() => acceptNote(midi, "key")} aria-label={`${midiName(midi)} 연주`}>
              <span>{midiName(midi).replace(/\d/, "")}</span>
            </button>
          ))}
          {KEYS.filter((midi) => BLACK.has(midi % 12)).map((midi) => {
            const precedingWhites = KEYS.filter((key) => key < midi && !BLACK.has(key % 12)).length;
            return <button key={midi} className="black-key" style={{ left: `${precedingWhites * 12.5 - 3.2}%` }} onClick={() => acceptNote(midi, "key")} aria-label={`${midiName(midi)} 연주`} />;
          })}
        </div>
      </section>

      <section className={`coach ${completed ? "complete" : ""}`}>
        <div className="coach-copy">
          <span className="status-dot" />
          <div><small>{completed ? "연습 완료" : micState === "listening" ? "듣고 있어요" : "준비됐나요?"}</small><h1>{message}</h1></div>
        </div>
        <div className="heard">
          <span>감지된 음</span><strong>{heardMidi === null ? "—" : midiName(heardMidi)}</strong>
          <i><b style={{ width: `${level * 100}%` }} /></i>
        </div>
        {completed ? (
          <button className="mic-button" onClick={reset}>다시 연주하기</button>
        ) : micState === "listening" ? (
          <button className="mic-button listening" onClick={stopMic}><span className="mic-icon">●</span> 듣기 중지</button>
        ) : (
          <button className="mic-button" onClick={startMic}><span className="mic-icon">●</span> 마이크 켜기</button>
        )}
      </section>

      <footer>조용한 곳에서 휴대폰을 피아노 중앙 가까이에 두면 더 정확해요. <span>화면 건반으로도 테스트할 수 있습니다.</span></footer>
    </main>
  );
}
