@echo off
chcp 936 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo.
echo ==================================================
echo    Simplexcel 一键打包 - 生成单文件 exe
echo ==================================================
echo.

set "TARGET=dist\Simplexcel.exe"

tasklist /fi "imagename eq Simplexcel.exe" 2>nul | find /i "Simplexcel.exe" >nul
if not errorlevel 1 (
    echo [注意] 检测到 Simplexcel.exe 正在运行，打包无法覆盖该文件。
    set /p "ANS=    先结束它再继续吗，输入 Y 后回车: "
    if /i "!ANS!"=="Y" (
        taskkill /f /im Simplexcel.exe >nul 2>&1
        echo     已结束该进程，继续。
    ) else (
        echo     已取消，没有做任何改动。
        goto :done
    )
)

where node >nul 2>&1
if errorlevel 1 (
    echo [x] 没找到 node 命令，请先安装 Node.js 18 或更高版本：https://nodejs.org/
    goto :done
)
for /f "delims=" %%v in ('node -v') do echo [1/4] Node.js %%v 已就绪

if not exist "node_modules\pkg\package.json" (
    echo [2/4] 缺少打包工具，正在安装依赖，只有第一次需要，可能要几分钟...
    call npm install --no-audit --no-fund
    if errorlevel 1 (
        echo [x] npm install 失败，检查网络后重新双击本脚本。
        goto :done
    )
) else (
    echo [2/4] 打包工具已就绪
)

if not exist "dist" mkdir "dist"
echo [3/4] 正在打包，开始时间 %TIME%
call node "node_modules\pkg\lib-es5\bin.js" package.json --targets node18-win-x64 --output "%TARGET%"
if errorlevel 1 (
    echo [x] 打包失败，把上面的报错内容发给开发者看看。
    goto :done
)

if exist "config.example.json" copy /y "config.example.json" "dist\config.example.json" >nul
echo [4/4] 打包完成，结束时间 %TIME%
echo.
call :report "%TARGET%"
echo.
echo   用法：把 exe 和你的 config.json 放同一个目录，双击运行。
echo   提醒：config.json 不会被拷进 dist，里面有你的 Token，注意别外发。
echo   exe 内嵌了 public 前端，改了 public 或 server.js 之后要重新双击一次本脚本。
echo.
goto :done

:report
echo   产物：%~f1
echo   大小：%~z1 字节    时间：%~t1
goto :eof

:done
echo.
pause
