export type MidiTone = { midi: number; duration: number };
export type MidiStep = { start: number; tones: MidiTone[] };
export type MidiImport = { title: string; steps: MidiStep[]; bpm: number };

export type MidiHistoryItem = {
  id: string; name: string; title: string; noteCount: number; importedAt: number;
};

type RawEvent = { tick: number; midi: number; channel: number; on: boolean };
type Span = { start: number; end: number; midi: number };

function readVar(data: Uint8Array, offset: number) {
  let value = 0, length = 0, byte = 0;
  do {
    if (offset + length >= data.length || length > 3) throw new Error("잘못된 MIDI 시간 데이터입니다.");
    byte = data[offset + length++];
    value = (value << 7) | (byte & 0x7f);
  } while (byte & 0x80);
  return { value, length };
}

function text(data: Uint8Array) {
  try { return new TextDecoder().decode(data).replace(/\0/g, "").trim(); }
  catch { return ""; }
}

export function parseMidiFile(buffer: ArrayBuffer, filename: string): MidiImport {
  const data = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (data.length < 14 || text(data.slice(0, 4)) !== "MThd") throw new Error("표준 MIDI(.mid) 파일이 아닙니다.");
  const headerLength = view.getUint32(4);
  const trackCount = view.getUint16(10);
  const rawDivision = view.getUint16(12);
  const division = rawDivision & 0x8000 ? 480 : Math.max(24, rawDivision);
  let offset = 8 + headerLength;
  let bpm = 90;
  const spans: Span[] = [];

  for (let trackIndex = 0; trackIndex < trackCount && offset + 8 <= data.length; trackIndex++) {
    if (text(data.slice(offset, offset + 4)) !== "MTrk") throw new Error("MIDI 트랙을 읽을 수 없습니다.");
    const length = view.getUint32(offset + 4);
    const end = Math.min(data.length, offset + 8 + length);
    let cursor = offset + 8, tick = 0, runningStatus = 0;
    const events: RawEvent[] = [];

    while (cursor < end) {
      const delta = readVar(data, cursor);
      tick += delta.value; cursor += delta.length;
      if (cursor >= end) break;
      let status = data[cursor];
      if (status < 0x80) {
        if (!runningStatus) throw new Error("MIDI 이벤트를 읽을 수 없습니다.");
        status = runningStatus;
      } else {
        cursor++;
        if (status < 0xf0) runningStatus = status;
      }
      if (status === 0xff) {
        const type = data[cursor++];
        const size = readVar(data, cursor); cursor += size.length;
        if (type === 0x51 && size.value === 3 && bpm === 90) {
          const micros = (data[cursor] << 16) | (data[cursor + 1] << 8) | data[cursor + 2];
          if (micros) bpm = Math.round(60000000 / micros);
        }
        cursor += size.value; continue;
      }
      if (status === 0xf0 || status === 0xf7) {
        const size = readVar(data, cursor); cursor += size.length + size.value; continue;
      }
      const command = status & 0xf0, channel = status & 0x0f;
      const first = data[cursor++];
      const second = command !== 0xc0 && command !== 0xd0 ? data[cursor++] : 0;
      if (channel !== 9 && (command === 0x80 || command === 0x90)) {
        events.push({ tick, midi: first, channel, on: command === 0x90 && second > 0 });
      }
    }

    const active = new Map<string, number[]>();
    for (const event of events) {
      const key = `${event.channel}:${event.midi}`;
      if (event.on) active.set(key, [...(active.get(key) ?? []), event.tick]);
      else {
        const starts = active.get(key);
        const start = starts?.shift();
        if (start !== undefined) spans.push({ start, end: Math.max(start + 1, event.tick), midi: event.midi });
      }
    }
    for (const [key, starts] of active) {
      const midi = Number(key.split(":")[1]);
      for (const start of starts) spans.push({ start, end: start + division, midi });
    }
    offset = end;
  }

  if (spans.length < 3) throw new Error("연주할 피아노 노트를 찾지 못했습니다.");
  spans.sort((a, b) => a.start - b.start || a.midi - b.midi);
  const tolerance = Math.max(1, Math.floor(division / 24));
  const groups: Span[][] = [];
  for (const span of spans) {
    const last = groups[groups.length - 1];
    if (!last || span.start - last[0].start > tolerance) groups.push([span]);
    else last.push(span);
  }
  const firstTick = groups[0][0].start;
  const steps = groups.slice(0, 2000).map((group) => ({
    start: (group[0].start - firstTick) / division,
    tones: [...new Map(group.map((span) => [span.midi, { midi: span.midi, duration: Math.max(0.12, (span.end - span.start) / division) }])).values()].sort((a, b) => a.midi - b.midi),
  }));
  return { title: filename.replace(/\.(mid|midi)$/i, ""), steps, bpm: Math.min(200, Math.max(40, bpm)) };
}

const DB_NAME = "pianote-midi", STORE = "files";
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function saveMidi(id: string, buffer: ArrayBuffer) {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => { const request = db.transaction(STORE, "readwrite").objectStore(STORE).put(buffer, id); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); });
  db.close();
}
export async function loadMidi(id: string): Promise<ArrayBuffer | null> {
  const db = await openDb();
  const result = await new Promise<ArrayBuffer | null>((resolve, reject) => { const request = db.transaction(STORE).objectStore(STORE).get(id); request.onsuccess = () => resolve((request.result as ArrayBuffer | undefined) ?? null); request.onerror = () => reject(request.error); });
  db.close(); return result;
}
export async function deleteMidi(id: string) {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => { const request = db.transaction(STORE, "readwrite").objectStore(STORE).delete(id); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); });
  db.close();
}
