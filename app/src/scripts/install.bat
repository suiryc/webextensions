@echo off

SET id=suiryc.webext.native

cd "%~dp0"

echo.
echo .. Installing NPM modules
call npm install readable-stream source-map-support

echo.
echo .. Creating Firefox registry entry
REG ADD "HKCU\SOFTWARE\Mozilla\NativeMessagingHosts\%id%" /ve /t REG_SZ /d "%~dp0manifest-firefox.json" /f

echo.
echo ^>^>^> Native Client is registered ^<^<^<
echo.

pause
