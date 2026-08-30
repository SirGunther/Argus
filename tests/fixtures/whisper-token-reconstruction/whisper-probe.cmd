@echo off
if /I "%ARGUS_WHISPER_FIXTURE%"=="transcribing" type "%ARGUS_WHISPER_FIXTURE_ROOT%\transcribing.json" > "%~7.json" & exit /b 0
if /I "%ARGUS_WHISPER_FIXTURE%"=="im" type "%ARGUS_WHISPER_FIXTURE_ROOT%\im.json" > "%~7.json" & exit /b 0
if /I "%ARGUS_WHISPER_FIXTURE%"=="punctuation" type "%ARGUS_WHISPER_FIXTURE_ROOT%\punctuation.json" > "%~7.json" & exit /b 0
if /I "%ARGUS_WHISPER_FIXTURE%"=="blank-audio" type "%ARGUS_WHISPER_FIXTURE_ROOT%\blank-audio.json" > "%~7.json" & exit /b 0
exit /b 1
