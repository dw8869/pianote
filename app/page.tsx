"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { deleteMidi, loadMidi, MidiHistoryItem, parseMidiFile, saveMidi } from "./midi";

type Note = { midi: number; name: string; hand: "R" | "L"; pitches: number[] };
type Song = { id: string; title: string; subtitle: string; level: string; notes: Note[] };
type RecognitionMode = "off" | "pitch" | "piano";

const makeNotes = (midis: number[]): Note[] => midis.map((midi) => ({ midi, name: midiName(midi), hand: "R", pitches: [midi] }));
const makeChordNotes = (chords: number[][]): Note[] => chords.map((pitches) => {
  const sorted = [...new Set(pitches)].sort((a, b) => a - b);
  const midi = sorted[sorted.length - 1];
  return { midi, name: midiName(midi), hand: "R", pitches: sorted };
});

const SONGS: Song[] = [
  { id: "ode", title: "환희의 송가", subtitle: "베토벤", level: "입문", notes: makeNotes([64,64,65,67,67,65,64,62,60,60,62,64,64,62,62]) },
  { id: "twinkle", title: "작은 별", subtitle: "프랑스 전래곡", level: "입문", notes: makeNotes([60,60,67,67,69,69,67,65,65,64,64,62,62,60]) },
  { id: "mary", title: "메리의 작은 양", subtitle: "미국 전래곡", level: "입문", notes: makeNotes([64,62,60,62,64,64,64,62,62,62,64,67,67]) },
  { id: "jingle", title: "징글벨", subtitle: "제임스 피어폰트", level: "초급", notes: makeNotes([64,64,64,64,64,64,64,67,60,62,64,65,65,65,65,65,64,64,64,64,62,62,64,62,67]) },
  { id: "frere", title: "자크 형제", subtitle: "프랑스 전래곡", level: "초급", notes: makeNotes([60,62,64,60,60,62,64,60,64,65,67,64,65,67]) },
  { id: "scale", title: "다장조 음계", subtitle: "기초 손가락 연습", level: "연습", notes: makeNotes([60,62,64,65,67,69,71,72,71,69,67,65,64,62,60]) },
];

const BLACK = new Set([1, 3, 6, 8, 10]);
const HISTORY_COOKIE = "pianote_midi_history";

function readHistory(): MidiHistoryItem[] {
  if (typeof document === "undefined") return [];
  const value = document.cookie.split("; ").find((part) => part.startsWith(`${HISTORY_COOKIE}=`))?.split("=").slice(1).join("=");
  if (!value) return [];
  try { return JSON.parse(decodeURIComponent(value)) as MidiHistoryItem[]; }
  catch { return []; }
}

function writeHistory(items: MidiHistoryItem[]) {
  document.cookie = `${HISTORY_COOKIE}=${encodeURIComponent(JSON.stringify(items.slice(0, 8)))}; Max-Age=31536000; Path=/; SameSite=Lax; Secure`;
}

function midiName(midi: number) {
  const names = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
  return `${names[midi % 12]}${Math.floor(midi / 12) - 1}`;
}

function frequencyToMidi(frequency: number) {
  return Math.round(69 + 12 * Math.log2(frequency / 440));
}

function keyCenter(midi: number, keys: number[]) {
  const whiteKeys = keys.filter((key) => !BLACK.has(key % 12));
  const whiteWidth = 100 / whiteKeys.length;
  if (BLACK.has(midi % 12)) {
    return keys.filter((key) => key < midi && !BLACK.has(key % 12)).length * whiteWidth;
  }
  const whiteIndex = whiteKeys.indexOf(midi);
  return (Math.max(0, whiteIndex) + 0.5) * whiteWidth;
}

function detectPianoOnset(buffer: Float32Array, spectrum: Float32Array, state: { noise: number; previousRms: number; lastOnset: number }, now: number) {
  let rms = 0;
  let peak = 0;
  let crossings = 0;
  for (let i = 1; i < buffer.length; i++) {
    rms += buffer[i] * buffer[i];
    peak = Math.max(peak, Math.abs(buffer[i]));
    if ((buffer[i] >= 0) !== (buffer[i - 1] >= 0)) crossings++;
  }
  rms = Math.sqrt(rms / buffer.length);
  const rise = rms - state.previousRms;
  state.previousRms = rms;

  let arithmetic = 0;
  let logSum = 0;
  let bins = 0;
  for (let i = 4; i < Math.min(spectrum.length, 430); i++) {
    const magnitude = Math.pow(10, Math.max(-100, spectrum[i]) / 20);
    arithmetic += magnitude;
    logSum += Math.log(magnitude + 1e-9);
    bins++;
  }
  const flatness = Math.exp(logSum / bins) / (arithmetic / bins + 1e-9);
  const crest = peak / (rms + 1e-6);
  const zcr = crossings / buffer.length;
  const threshold = Math.max(0.007, state.noise * 2.4);
  const onset = rms > threshold && rise > Math.max(0.003, state.noise * 0.7) && crest > 1.7 && flatness < 0.48 && zcr < 0.34 && now - state.lastOnset > 220;
  if (onset) state.lastOnset = now;
  else if (rms < threshold) state.noise = state.noise * 0.97 + rms * 0.03;
  return { onset, level: rms, flatness };
}

function detectPitchYin(buffer: Float32Array, sampleRate: number) {
  let mean = 0;
  for (const value of buffer) mean += value;
  mean /= buffer.length;
  let rms = 0;
  for (const value of buffer) rms += (value - mean) ** 2;
  rms = Math.sqrt(rms / buffer.length);
  if (rms < 0.006) return { frequency: -1, clarity: 0, level: rms };

  // YIN's cumulative mean normalized difference rejects piano harmonics much
  // more reliably than choosing the largest autocorrelation peak.
  const minTau = Math.max(2, Math.floor(sampleRate / 1200));
  const maxTau = Math.min(Math.floor(sampleRate / 55), Math.floor(buffer.length / 2) - 1);
  const windowLength = Math.min(2048, buffer.length - maxTau);
  const difference = new Float32Array(maxTau + 1);
  for (let tau = minTau; tau <= maxTau; tau++) {
    let sum = 0;
    for (let i = 0; i < windowLength; i++) {
      const delta = buffer[i] - buffer[i + tau];
      sum += delta * delta;
    }
    difference[tau] = sum;
  }

  let runningSum = 0;
  let selectedTau = -1;
  let bestTau = -1;
  let bestValue = 1;
  for (let tau = minTau; tau <= maxTau; tau++) {
    runningSum += difference[tau];
    const normalized = runningSum > 0 ? difference[tau] * (tau - minTau + 1) / runningSum : 1;
    difference[tau] = normalized;
    if (normalized < bestValue) { bestValue = normalized; bestTau = tau; }
  }
  for (let tau = minTau; tau <= maxTau; tau++) {
    if (difference[tau] >= 0.16) continue;
    while (tau + 1 <= maxTau && difference[tau + 1] < difference[tau]) tau++;
    selectedTau = tau;
    break;
  }
  if (selectedTau < 0 && bestValue < 0.3) selectedTau = bestTau;
  if (selectedTau < 0) return { frequency: -1, clarity: 0, level: rms };

  const left = difference[Math.max(minTau, selectedTau - 1)];
  const center = difference[selectedTau];
  const right = difference[Math.min(maxTau, selectedTau + 1)];
  const denominator = 2 * (2 * center - right - left);
  const refinedTau = denominator ? selectedTau + (right - left) / denominator : selectedTau;
  return { frequency: sampleRate / refinedTau, clarity: 1 - center, level: rms };
}

export default function Home() {
  const [songId, setSongId] = useState(SONGS[0].id);
  const [customSongs, setCustomSongs] = useState<Song[]>([]);
  const [history, setHistory] = useState<MidiHistoryItem[]>([]);
  const [importError, setImportError] = useState("");
  const [isImporting, setIsImporting] = useState(false);
  const [index, setIndex] = useState(0);
  const [recognitionMode, setRecognitionMode] = useState<RecognitionMode>("off");
  const [micState, setMicState] = useState<"idle" | "listening" | "error">("idle");
  const [heardMidi, setHeardMidi] = useState<number | null>(null);
  const [level, setLevel] = useState(0);
  const [message, setMessage] = useState("마이크를 켜고 첫 음 E4를 연주하세요");
  const [completed, setCompleted] = useState(false);
  const audioRef = useRef<{ context: AudioContext; stream: MediaStream; frame: number } | null>(null);
  const stableRef = useRef({ midi: -1, count: 0, lastAdvance: 0, recent: [] as number[], silence: 0, lockedMidi: -1 });
  const indexRef = useRef(index);
  indexRef.current = index;
  const allSongs = [...SONGS, ...customSongs];
  const song = allSongs.find((item) => item.id === songId) ?? SONGS[0];

  useEffect(() => setHistory(readHistory()), []);

  const advanceStep = useCallback(() => {
    if (completed) return;
    const next = indexRef.current + 1;
    if (next >= song.notes.length) {
      setCompleted(true);
      setMessage(`연주 완료! ${song.title}을(를) 끝까지 연주했어요.`);
    } else {
      indexRef.current = next;
      setIndex(next);
      const nextNames = song.notes[next].pitches.map(midiName).join(" · ");
      setMessage(`좋아요! 다음은 ${nextNames}`);
    }
  }, [completed, song]);

  const acceptNote = useCallback((midi: number, source: "mic" | "key" = "mic") => {
    if (completed) return;
    const expected = song.notes[indexRef.current].midi;
    setHeardMidi(midi);
    if (midi !== expected) {
      setMessage(`${midiName(midi)}가 들려요 · ${midiName(expected)}를 연주해 보세요`);
      return;
    }
    if (source === "mic") {
      const now = performance.now();
      const stable = stableRef.current;
      if (stable.lockedMidi === midi) return;
      stable.recent.push(midi);
      if (stable.recent.length > 5) stable.recent.shift();
      const sorted = [...stable.recent].sort((a, b) => a - b);
      if (stable.recent.length >= 3 && sorted[Math.floor(sorted.length / 2)] !== midi) return;
      stable.count = stable.midi === midi ? stable.count + 1 : 1;
      stable.midi = midi;
      if (stable.count < 3 || now - stable.lastAdvance < 450) return;
      stable.lastAdvance = now;
      stable.count = 0;
      stable.lockedMidi = midi;
    }
    advanceStep();
  }, [advanceStep, completed, song]);

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
      analyser.minDecibels = -100;
      analyser.maxDecibels = -20;
      analyser.smoothingTimeConstant = 0;
      source.connect(analyser);
      const data = new Float32Array(analyser.fftSize);
      const spectrum = new Float32Array(analyser.frequencyBinCount);
      const onsetState = { noise: 0.004, previousRms: 0, lastOnset: 0 };
      const audio = { context, stream, frame: 0 };
      audioRef.current = audio;
      setMicState("listening");
      setMessage(recognitionMode === "piano" ? "건반을 한 번 연주해 보세요" : `${song.notes[indexRef.current].name}를 연주해 보세요`);

      let lastAnalysis = 0;
      const analyse = (time: number) => {
        if (!audioRef.current) return;
        if (time - lastAnalysis > 65) {
          analyser.getFloatTimeDomainData(data);
          if (recognitionMode === "piano") {
            analyser.getFloatFrequencyData(spectrum);
            const hit = detectPianoOnset(data, spectrum, onsetState, time);
            setLevel(Math.min(1, hit.level * 18));
            if (hit.onset) {
              setHeardMidi(null);
              advanceStep();
            }
          } else {
            const result = detectPitchYin(data, context.sampleRate);
            setLevel(Math.min(1, result.level * 18));
            const stable = stableRef.current;
            if (result.frequency > 0 && result.clarity > 0.7) {
              stable.silence = 0;
              acceptNote(frequencyToMidi(result.frequency));
            } else {
              stable.silence++;
              if (stable.silence >= 3) {
                stable.lockedMidi = -1;
                stable.midi = -1;
                stable.count = 0;
                stable.recent = [];
              }
            }
          }
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

  function changeRecognitionMode(mode: RecognitionMode) {
    stopMic();
    setRecognitionMode(mode);
    setLevel(0);
    setHeardMidi(null);
    const copy = mode === "off" ? "마이크 인식이 꺼졌습니다" : mode === "piano" ? "어떤 건반 소리든 감지하면 진행합니다" : "정확한 목표 음을 인식합니다";
    setMessage(copy);
  }

  function reset() {
    indexRef.current = 0;
    stableRef.current = { midi: -1, count: 0, lastAdvance: 0, recent: [], silence: 0, lockedMidi: -1 };
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
    stableRef.current = { midi: -1, count: 0, lastAdvance: 0, recent: [], silence: 0, lockedMidi: -1 };
    setIndex(0);
    setCompleted(false);
    setHeardMidi(null);
    setLevel(0);
    setMessage(`마이크를 켜고 첫 음 ${nextSong.notes[0].name}를 연주하세요`);
  }

  function songFromMidi(id: string, title: string, chords: number[][]): Song {
    return { id: `midi-${id}`, title, subtitle: "내 MIDI · 기기 내 저장", level: "MIDI", notes: makeChordNotes(chords) };
  }

  async function importBuffer(buffer: ArrayBuffer, filename: string, existingId?: string) {
    setIsImporting(true);
    setImportError("");
    try {
      const parsed = parseMidiFile(buffer, filename);
      const id = existingId ?? `${Date.now().toString(36)}-${buffer.byteLength.toString(36)}`;
      await saveMidi(id, buffer);
      const item: MidiHistoryItem = { id, name: filename.slice(0, 80), title: parsed.title.slice(0, 60), noteCount: parsed.chords.length, importedAt: Date.now() };
      const nextHistory = [item, ...history.filter((entry) => entry.id !== id)].slice(0, 8);
      setHistory(nextHistory);
      writeHistory(nextHistory);
      const nextSong = songFromMidi(id, parsed.title, parsed.chords);
      setCustomSongs((songs) => [...songs.filter((entry) => entry.id !== nextSong.id), nextSong]);
      selectSong(nextSong);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "MIDI 파일을 읽지 못했습니다.");
    } finally { setIsImporting(false); }
  }

  async function handleMidiFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) await importBuffer(await file.arrayBuffer(), file.name);
    event.target.value = "";
  }

  async function reopenMidi(item: MidiHistoryItem) {
    const buffer = await loadMidi(item.id);
    if (!buffer) {
      setImportError("이 기기에서 MIDI 파일을 찾지 못했습니다. 다시 불러와 주세요.");
      return;
    }
    await importBuffer(buffer, item.name, item.id);
  }

  async function removeHistory(item: MidiHistoryItem) {
    await deleteMidi(item.id);
    const nextHistory = history.filter((entry) => entry.id !== item.id);
    setHistory(nextHistory);
    writeHistory(nextHistory);
    setCustomSongs((songs) => songs.filter((entry) => entry.id !== `midi-${item.id}`));
    if (songId === `midi-${item.id}`) selectSong(SONGS[0]);
  }

  const current = song.notes[index];
  const visibleNotes = song.notes.slice(index, index + 6);
  const lowestPitch = Math.min(...current.pitches);
  const highestPitch = Math.max(...current.pitches);
  const keyboardStart = lowestPitch - (lowestPitch % 12);
  const keyboardEnd = Math.max(keyboardStart + 12, highestPitch + ((12 - highestPitch % 12) % 12));
  const keyboardKeys = Array.from({ length: keyboardEnd - keyboardStart + 1 }, (_, keyIndex) => keyboardStart + keyIndex);
  const whiteKeyCount = keyboardKeys.filter((midi) => !BLACK.has(midi % 12)).length;

  return (
    <main>
      <header className="topbar">
        <a className="brand" href="#" aria-label="Pianote 홈"><span>p</span>Pianote</a>
        <div className="lesson-pill">{song.level} <b>·</b> {song.title}</div>
        <button className="icon-button" onClick={reset} aria-label="연습 다시 시작">↻</button>
      </header>

      <nav className="song-library" aria-label="연습곡 선택">
        <div className="library-heading"><span>연습곡</span><strong>{allSongs.length}곡</strong></div>
        <div className="song-list">
          {allSongs.map((item, songIndex) => (
            <button key={item.id} className={`song-card ${item.id === song.id ? "selected" : ""}`} onClick={() => selectSong(item)} aria-pressed={item.id === song.id}>
              <span className="song-number">{String(songIndex + 1).padStart(2, "0")}</span>
              <span className="song-info"><strong>{item.title}</strong><small>{item.subtitle} · {item.notes.length}음</small></span>
              <em>{item.level}</em>
            </button>
          ))}
          <label className="import-card">
            <input type="file" accept=".mid,.midi,audio/midi,audio/x-midi" onChange={handleMidiFile} disabled={isImporting} />
            <span className="import-plus">+</span>
            <span><strong>{isImporting ? "불러오는 중…" : "내 MIDI 불러오기"}</strong><small>파일은 이 기기에만 저장됩니다</small></span>
          </label>
        </div>
        {history.length > 0 && <div className="recent-midi"><span className="recent-label">최근 MIDI</span><div className="recent-list">{history.map((item) => <div className="recent-item" key={item.id}><button onClick={() => reopenMidi(item)}><strong>{item.title}</strong><small>{item.noteCount}음</small></button><button className="remove-midi" onClick={() => removeHistory(item)} aria-label={`${item.title} 기록 삭제`}>×</button></div>)}</div></div>}
        {importError && <p className="import-error" role="alert">{importError}</p>}
      </nav>

      <section className="practice" aria-live="polite">
        <div className="recognition-settings" aria-label="마이크 인식 방식">
          <span>진행 방식</span>
          <div>{([['off','인식 안 함'],['piano','건반 소리'],['pitch','정확한 음']] as [RecognitionMode,string][]).map(([mode,label]) => <button key={mode} className={recognitionMode === mode ? "selected" : ""} onClick={() => changeRecognitionMode(mode)} aria-pressed={recognitionMode === mode}>{label}</button>)}</div>
        </div>
        <div className="progress-row">
          <span>{completed ? "완료" : `${index + 1}번째 음`}</span>
          <div className="progress"><i style={{ width: `${completed ? 100 : ((index + 1) / song.notes.length) * 100}%` }} /></div>
          <strong>{completed ? song.notes.length : index + 1} / {song.notes.length}</strong>
        </div>
        {current.pitches.length > 1 && <div className="chord-guide"><span>화음 · 양손</span><strong>{current.pitches.map(midiName).join("  +  ")}</strong></div>}

        <div className="falling-stage">
          <div className="staff-lines" />
          {visibleNotes.flatMap((note, position) => note.pitches.map((pitch) => {
            const isLeft = pitch < 60;
            return (
              <div
                className={`falling-note ${position === 0 ? "active" : ""} ${isLeft ? "left-hand" : "right-hand"}`}
                key={`${index}-${position}-${pitch}`}
                style={{ left: `calc(${keyCenter(pitch, keyboardKeys)}% - 17px)`, bottom: `${position * 78 + 30}px` }}
              >
                <span>{midiName(pitch).replace(/\d/, "")}</span>
              </div>
            );
          }))}
          <div className="target-line"><span>여기서 연주</span></div>
        </div>

        <div className="keyboard" aria-label="테스트용 피아노 건반">
          {keyboardKeys.filter((midi) => !BLACK.has(midi % 12)).map((midi) => (
            <button key={midi} className={`white-key ${current.pitches.includes(midi) ? "target" : ""}`} onClick={() => acceptNote(midi, "key")} aria-label={`${midiName(midi)} 연주`}>
              <span>{midiName(midi).replace(/\d/, "")}</span>
            </button>
          ))}
          {keyboardKeys.filter((midi) => BLACK.has(midi % 12)).map((midi) => {
            const precedingWhites = keyboardKeys.filter((key) => key < midi && !BLACK.has(key % 12)).length;
            const whiteWidth = 100 / whiteKeyCount;
            return <button key={midi} className={`black-key ${current.pitches.includes(midi) ? "target" : ""}`} style={{ left: `${precedingWhites * whiteWidth - whiteWidth * 0.26}%`, width: `${whiteWidth * 0.52}%` }} onClick={() => acceptNote(midi, "key")} aria-label={`${midiName(midi)} 연주`}><span>{midiName(midi).replace(/\d/, "")}</span></button>;
          })}
        </div>
      </section>

      <section className={`coach ${completed ? "complete" : ""}`}>
        <div className="coach-copy">
          <span className="status-dot" />
          <div><small>{completed ? "연습 완료" : micState === "listening" ? "듣고 있어요" : "준비됐나요?"}</small><h1>{message}</h1></div>
        </div>
        <div className="heard">
          <span>{recognitionMode === "piano" ? "건반 감지" : "감지된 음"}</span><strong>{recognitionMode === "piano" ? (micState === "listening" ? "♪" : "—") : heardMidi === null ? "—" : midiName(heardMidi)}</strong>
          <i><b style={{ width: `${level * 100}%` }} /></i>
        </div>
        {completed ? (
          <button className="mic-button" onClick={reset}>다시 연주하기</button>
        ) : recognitionMode === "off" ? (
          <button className="mic-button disabled" disabled>마이크 인식 꺼짐</button>
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
