@echo off
cd /d "%~dp0"
"C:\xampp\php\php.exe" -d post_max_size=24M -d memory_limit=256M -S 127.0.0.1:3000 -t "%~dp0" php-router.php
