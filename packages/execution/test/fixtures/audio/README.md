# Аудиофикстуры

Синтетические тона, созданные локально FFmpeg. Записей людей и ответов провайдеров нет. Тесты читают готовые файлы и не требуют установленного FFmpeg.

```sh
ffmpeg -f lavfi -i 'sine=frequency=440:sample_rate=44100:duration=0.08' -ac 2 -c:a libmp3lame -b:a 64k tone.mp3
ffmpeg -f lavfi -i 'sine=frequency=660:sample_rate=22050:duration=0.08' -ac 1 -c:a libmp3lame -q:a 5 tone-vbr.mp3
ffmpeg -f lavfi -i 'sine=frequency=440:sample_rate=8000:duration=0.08' -ac 1 -c:a adpcm_ima_wav tone-ima.wav
ffmpeg -f lavfi -i 'sine=frequency=440:sample_rate=8000:duration=0.08' -ac 1 -c:a adpcm_ms tone-ms.wav
```

MP3 проверяют MPEG-1 stereo CBR и MPEG-2 mono VBR; оба содержат ID3/Xing metadata. WAV проверяют блочное сжатие IMA и MS ADPCM. Несжатый WAV создаётся функцией `wavFixture` в соседнем файле.
