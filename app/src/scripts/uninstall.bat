@echo off

SET id=suiryc.webext.native

echo .. Deleting Firefox registry entry
REG DELETE "HKCU\SOFTWARE\Mozilla\NativeMessagingHosts\%id%" /f

echo.
echo ^>^>^> Native Client is unregistered ^<^<^<
echo.

pause
