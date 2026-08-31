import React, { useEffect, useRef, useState } from 'react';
import { Play, Pause, Loader2 } from 'lucide-react';
import './VoiceMessage.css';

const BAR_COUNT = 20;

const formatDuration = (seconds: number) => {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
};

interface VoiceMessageProps {
  src: string;
  mine: boolean;
}

// Как в Telegram/WhatsApp — играет только одно голосовое одновременно.
// Модульный синглтон, а не React-контекст, потому что это чисто императивное
// "останови предыдущее", без надобности где-либо читать это как состояние.
let activePlayer: { audio: HTMLAudioElement; stop: () => void } | null = null;

// Настоящая амплитудная огибающая (как в Telegram/WhatsApp), не подделка и не
// анализ спектра — просто пик громкости по срезам семплов. Декодируется через
// Web Audio API один раз при монтировании, много дешевле, чем кажется: минутный
// голосовой — это доли МБ, decodeAudioData отрабатывает за миллисекунды.
export const VoiceMessage: React.FC<VoiceMessageProps> = ({ src, mine }) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);

  // Раньше файл качался дважды: один раз тут ради waveform, второй раз
  // браузером через <audio src>, когда жмут play — и на время второй
  // скачки играющая кнопка просто "молчала", будто зависла. Теперь качаем
  // один раз, строим и waveform, и blob-URL для самого <audio> из тех же
  // байт — play срабатывает мгновенно, а спиннер честно показывает именно
  // тот единственный сетевой запрос, который идёт по этому сообщению.
  useEffect(() => {
    let cancelled = false;
    let createdUrl: string | null = null;

    (async () => {
      try {
        const response = await fetch(src);
        const contentType = response.headers.get('content-type') || 'audio/webm';
        const arrayBuffer = await response.arrayBuffer();

        if (!cancelled) {
          createdUrl = URL.createObjectURL(new Blob([arrayBuffer], { type: contentType }));
          setObjectUrl(createdUrl);
        }

        const AudioContextCtor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const audioCtx = new AudioContextCtor();
        // decodeAudioData нейтрализует переданный буфер — отдаём ему копию,
        // оригинал ещё нужен для blob-URL выше.
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
        const channel = audioBuffer.getChannelData(0);
        const blockSize = Math.max(1, Math.floor(channel.length / BAR_COUNT));

        const rawPeaks: number[] = [];
        for (let i = 0; i < BAR_COUNT; i++) {
          const start = i * blockSize;
          let peak = 0;
          for (let j = 0; j < blockSize; j++) {
            const v = Math.abs(channel[start + j] ?? 0);
            if (v > peak) peak = v;
          }
          rawPeaks.push(peak);
        }

        const max = Math.max(...rawPeaks, 0.01);
        await audioCtx.close();
        if (!cancelled) setPeaks(rawPeaks.map((p) => Math.max(0.12, p / max)));
      } catch (err) {
        console.error('Не удалось загрузить голосовое', err);
        if (!cancelled) {
          setPeaks(Array(BAR_COUNT).fill(0.3));
          // Без своего blob-URL — пусть браузер попробует стримить исходный
          // src сам, как и раньше, до этой оптимизации.
          if (!createdUrl) setObjectUrl(src);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [src]);

  // objectUrl появляется асинхронно (после fetch), а <audio> рендерится
  // только когда он уже есть — на самом первом маунте компонента audioRef.current
  // ещё null, и с пустым [] этот эффект так и не перевешивался бы заново после
  // того как элемент реально появился в DOM. Отсюда была "тишина" анимации и
  // залипшая кнопка (ended никогда не срабатывал).
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onTime = () => {
      setCurrentTime(audio.currentTime);
      if (Number.isFinite(audio.duration)) setProgress(audio.currentTime / audio.duration);
    };
    // Голосовые с Android/Chrome — webm/opus от MediaRecorder, а он пишет
    // поток без duration-box в конце файла. Известный баг Chromium: duration
    // такого blob'а резолвится в Infinity, а не в реальное число (у iOS
    // audio/mp4 duration-box есть всегда, там этой болячки нет). "Infinity"
    // тихо протекал и в таймкод (formatDuration рисовал "Infinity:NaN"), и в
    // progress волны (currentTime / Infinity == 0 всегда). Лечится
    // стандартным воркэраундом: форс-сик в дальний конец заставляет браузер
    // пересчитать реальную длительность и прислать её через 'durationchange',
    // после чего возвращаем позицию на 0.
    let onDurationChange: (() => void) | null = null;
    const onLoaded = () => {
      const d = audio.duration;
      if (Number.isFinite(d)) {
        setDuration(d || 0);
        return;
      }
      onDurationChange = () => {
        if (!Number.isFinite(audio.duration)) return;
        setDuration(audio.duration);
        audio.currentTime = 0;
        audio.removeEventListener('durationchange', onDurationChange!);
        onDurationChange = null;
      };
      audio.addEventListener('durationchange', onDurationChange);
      audio.currentTime = 1e101;
    };
    const onEnd = () => {
      setIsPlaying(false);
      setProgress(0);
      setCurrentTime(0);
      if (activePlayer?.audio === audio) activePlayer = null;
    };
    const onPause = () => {
      setIsPlaying(false);
      if (activePlayer?.audio === audio) activePlayer = null;
    };

    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('loadedmetadata', onLoaded);
    audio.addEventListener('ended', onEnd);
    audio.addEventListener('pause', onPause);
    return () => {
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('loadedmetadata', onLoaded);
      audio.removeEventListener('ended', onEnd);
      audio.removeEventListener('pause', onPause);
      if (onDurationChange) audio.removeEventListener('durationchange', onDurationChange);
      if (activePlayer?.audio === audio) activePlayer = null;
    };
  }, [objectUrl]);

  const togglePlay = async () => {
    const audio = audioRef.current;
    if (!audio || !objectUrl) return;
    if (isPlaying) {
      audio.pause();
      setIsPlaying(false);
      return;
    }
    // Останавливаем то, что играло до этого — иначе можно было запустить
    // сколько угодно голосовых сразу.
    if (activePlayer && activePlayer.audio !== audio) {
      activePlayer.stop();
    }
    try {
      // play() — промис. Раньше его не ждали и не ловили: если браузер (чаще
      // всего на первом тапе, пока WebKit ещё не догрузил/задекодировал
      // blob) отклонял или откладывал реальный старт звука, кнопка всё
      // равно тут же переключалась на "играет" — тишина с виду выглядела
      // как воспроизведение, и только второй тап реально запускал звук.
      // Теперь isPlaying выставляется только после того, как play() и
      // правда отработал.
      await audio.play();
      setIsPlaying(true);
      activePlayer = {
        audio,
        // currentTime = 0 (не только pause) — как в Telegram/WhatsApp: если
        // переключились на другое голосовое, недослушанное сбрасывается в
        // начало, а не просто замирает на середине. 'timeupdate' от смены
        // currentTime сам докатит progress/currentTime state вниз до 0 через
        // уже существующий onTime-обработчик.
        stop: () => {
          audio.pause();
          audio.currentTime = 0;
        },
      };
    } catch (err) {
      console.error('Не удалось воспроизвести голосовое', err);
      setIsPlaying(false);
    }
  };

  const seekTo = (e: React.MouseEvent<HTMLDivElement>) => {
    const audio = audioRef.current;
    if (!audio || !audio.duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    audio.currentTime = ratio * audio.duration;
    setProgress(ratio);
  };

  const bars = peaks ?? Array(BAR_COUNT).fill(0.15);
  const activeBars = Math.round(progress * bars.length);

  return (
    <div className={`voice-message ${mine ? 'mine' : ''} ${!objectUrl ? 'voice-message--loading' : ''}`}>
      {/* auto, не metadata — байты уже полностью в памяти (тот же fetch, что
          строил waveform выше), так что "auto" ничего лишнего не качает, а
          просто даёт WebKit задекодировать их сразу, не откладывая на первый
          play(). */}
      {objectUrl && <audio ref={audioRef} src={objectUrl} preload="auto" />}
      <button
        className="voice-play-button"
        onClick={togglePlay}
        disabled={!objectUrl}
        title={!objectUrl ? 'Загрузка…' : isPlaying ? 'Пауза' : 'Слушать'}
      >
        {!objectUrl ? <Loader2 size={20} className="spin" /> : isPlaying ? <Pause size={20} /> : <Play size={20} />}
      </button>
      <div className="voice-waveform" onClick={seekTo}>
        {bars.map((p, i) => (
          <span
            key={i}
            className={`voice-bar ${i < activeBars ? 'played' : ''}`}
            style={{ height: `${Math.round(p * 100)}%` }}
          />
        ))}
      </div>
      <span className="voice-duration">
        {formatDuration(isPlaying ? Math.max(0, duration - currentTime) : duration)}
      </span>
    </div>
  );
};
