@echo off
rem Builds MixerBridge.exe (the window for the bridge) with the C# compiler
rem that comes with Windows. Nothing to install.
setlocal
cd /d "%~dp0"
set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" set CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe
if not exist "%CSC%" (
  echo The C# compiler was not found. It comes with .NET Framework 4.
  exit /b 1
)
set OUT=..\MixerBridge.exe
set COMMON=/nologo /target:winexe /platform:anycpu /optimize+ /r:System.Web.Extensions.dll /r:System.Management.dll /resource:fonts\BarlowCondensed-SemiBold.ttf,BarlowCondensed-SemiBold.ttf /resource:fonts\Barlow-Regular.ttf,Barlow-Regular.ttf /resource:fonts\Barlow-Medium.ttf,Barlow-Medium.ttf

rem The program draws its own icon: build once without, let it draw, build again with.
"%CSC%" %COMMON% /out:icon-maker.exe MixerBridge.cs || exit /b 1
start "" /wait "%~dp0icon-maker.exe" --make-icon "%~dp0icon.ico"
del icon-maker.exe
"%CSC%" %COMMON% /win32icon:icon.ico /out:%OUT% MixerBridge.cs || exit /b 1
echo Built %OUT%

rem The helper that records a sound card for the spectrum (RTA).
"%CSC%" /nologo /target:exe /platform:anycpu /optimize+ /out:..\AudioTap.exe AudioTap.cs || exit /b 1
echo Built ..\AudioTap.exe
