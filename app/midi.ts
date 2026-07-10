export type MidiImport = {
  title: string;
  notes: number[];
  trackName: string;
};

export type MidiHistoryItem = {
  id: string;
  name: string;
  title: string;
  noteCount: number;
  importedAt: number;
};

type NoteEvent = { tick: number; note: number; channel: number };

function readVar(data: Uint8Array, offset: number) {
  let value = 0;
  let length = 0;
  let byte = 0;
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
  let offset = 8 + headerLength;
  const tracks: { name: string; events: NoteEvent[] }[] = [];

  for (let trackIndex = 0; trackIndex < trackCount && offset + 8 <= data.length; trackIndex++) {
    if (text(data.slice(offset, offset + 4)) !== "MTrk") throw new Error("MIDI 트랙을 읽을 수 없습니다.");
    const length = view.getUint32(offset + 4);
    const end = Math.min(data.length, offset + 8 + length);
    let cursor = offset + 8;
    let tick = 0;
    let runningStatus = 0;
    let trackName = "";
    const events: NoteEvent[] = [];

    while (cursor < end) {
      const delta = readVar(data, cursor);
      tick += delta.value;
      cursor += delta.length;
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
        const size = readVar(data, cursor);
        cursor += size.length;
        if (type === 0x03 && !trackName) trackName = text(data.slice(cursor, cursor + size.value));
        cursor += size.value;
        continue;
      }
      if (status === 0xf0 || status === 0xf7) {
        const size = readVar(data, cursor);
        cursor += size.length + size.value;
        continue;
      }

      const command = status & 0xf0;
      const channel = status & 0x0f;
      const first = data[cursor++];
      const hasSecond = command !== 0xc0 && command !== 0xd0;
      const second = hasSecond ? data[cursor++] : 0;
      if (command === 0x90 && second > 0 && channel !== 9) events.push({ tick, note: first, channel });
    }
    tracks.push({ name: trackName, events });
    offset = end;
  }

  const candidates = tracks.filter((track) => track.events.length >= 3);
  if (!candidates.length) throw new Error("연주할 피아노 노트를 찾지 못했습니다.");
  const melody = candidates.sort((a, b) => {
    const average = (events: NoteEvent[]) => events.reduce((sum, event) => sum + event.note, 0) / events.length;
    return (average(b.events) + Math.log2(b.events.length) * 2) - (average(a.events) + Math.log2(a.events.length) * 2);
  })[0];

  const notesByTick = new Map<number, number>();
  for (const event of melody.events) notesByTick.set(event.tick, Math.max(event.note, notesByTick.get(event.tick) ?? 0));
  const notes = [...notesByTick.entries()].sort((a, b) => a[0] - b[0]).map((entry) => entry[1]).slice(0, 2000);
  if (!notes.length) throw new Error("멜로디 노트가 없습니다.");
  return { title: filename.replace(/\.(mid|midi)$/i, ""), notes, trackName: melody.name || "Melody" };
}

const DB_NAME = "pianote-midi";
const STORE = "files";

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
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(STORE, "readwrite").objectStore(STORE).put(buffer, id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
  db.close();
}

export async function loadMidi(id: string): Promise<ArrayBuffer | null> {
  const db = await openDb();
  const result = await new Promise<ArrayBuffer | null>((resolve, reject) => {
    const request = db.transaction(STORE).objectStore(STORE).get(id);
    request.onsuccess = () => resolve((request.result as ArrayBuffer | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return result;
}

export async function deleteMidi(id: string) {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(STORE, "readwrite").objectStore(STORE).delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
  db.close();
}
