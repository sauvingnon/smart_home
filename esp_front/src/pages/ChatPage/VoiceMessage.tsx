import React, { useEffect, useRef, useState } from 'react';
import { Play, Pause } from 'lucide-react';
import './VoiceMessage.css';

const BAR_COUNT = 40;

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

// Настоящая амплитудная огибающая (как в Telegram/WhatsApp), не подделка и не
// анализ спектра — просто пик громкости по срезам семплов. Декодируется через
// Web Audio API один раз при монтировании, много дешевле, чем кажется: минутный
// голосовой — это доли МБ, decodeAudioData отрабатывает за миллисекунды.
export const VoiceMessage: React.FC<VoiceMessageProps> = ({ src, mine }) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const AudioContextCtor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const response = await fetch(src);
        const arrayBuffer = await response.arrayBuffer();
        const audioCtx = new AudioContextCtor();
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
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
        console.error('Не удалось построить waveform', err);
        if (!cancelled) setPeaks(Array(BAR_COUNT).fill(0.3));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [src]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onTime = () => {
      setCurrentTime(audio.currentTime);
      if (audio.duration) setProgress(audio.currentTime / audio.duration);
    };
    const onLoaded = () => setDuration(audio.duration || 0);
    const onEnd = () => {
      setIsPlaying(false);
      setProgress(0);
      setCurrentTime(0);
    };

    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('loadedmetadata', onLoaded);
    audio.addEventListener('ended', onEnd);
    return () => {
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('loadedmetadata', onLoaded);
      audio.removeEventListener('ended', onEnd);
    };
  }, []);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      audio.pause();
      setIsPlaying(false);
    } else {
      audio.play();
      setIsPlaying(true);
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
    <div className={`voice-message ${mine ? 'mine' : ''}`}>
      <audio ref={audioRef} src={src} preload="metadata" />
      <button className="voice-play-button" onClick={togglePlay} title={isPlaying ? 'Пауза' : 'Слушать'}>
        {isPlaying ? <Pause size={16} /> : <Play size={16} />}
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
