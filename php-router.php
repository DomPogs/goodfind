<?php
declare(strict_types=1);

$requestPath = rawurldecode((string)(parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/'));
$blocked = preg_match('#(?:^|/)(?:\.env|\.git|database|server-data|logs)(?:/|$)#i', $requestPath)
    || preg_match('#(?:^|/)(?:server\.js|package(?:-lock)?\.json)(?:/|$)#i', $requestPath);
if ($blocked) { http_response_code(404); exit; }

// Serve the app through PHP pages. Keep old .html links working as aliases.
$pageAliases = [
    '/' => '/index.php',
    '/index.html' => '/index.php',
    '/marketplace.html' => '/marketplace.php',
    '/profile.html' => '/profile.php',
    '/orders.html' => '/orders.php',
    '/auth/' => '/auth/index.php',
    '/auth/index.html' => '/auth/index.php',
    '/admin/' => '/admin/live.php',
    '/admin/live.html' => '/admin/live.php',
    '/admin/index.html' => '/admin/index.php',
    '/auth/auth/' => '/auth/auth/index.php',
    '/auth/auth/index.html' => '/auth/auth/index.php',
    '/admin/admin/' => '/admin/admin/live.php',
    '/admin/admin/live.html' => '/admin/admin/live.php',
    '/admin/admin/index.html' => '/admin/admin/index.php',
];
$targetPath = $pageAliases[$requestPath] ?? $requestPath;

$root = realpath(__DIR__);
$candidate = realpath(__DIR__ . DIRECTORY_SEPARATOR . ltrim(str_replace(['/', '\\'], DIRECTORY_SEPARATOR, $targetPath), DIRECTORY_SEPARATOR));
if ($candidate === false || ($candidate !== $root && !str_starts_with(strtolower($candidate), strtolower($root . DIRECTORY_SEPARATOR)))) {
    http_response_code(404); exit;
}

if ($targetPath === '/api.php') { require $candidate; exit; }

$allowedPages = [
    '/index.php', '/marketplace.php', '/profile.php', '/orders.php',
    '/auth/index.php', '/auth/auth/index.php',
    '/admin/live.php', '/admin/index.php',
    '/admin/admin/live.php', '/admin/admin/index.php',
];
if (in_array($targetPath, $allowedPages, true)) { require $candidate; exit; }

if (str_ends_with(strtolower($requestPath), '.php')) { http_response_code(404); exit; }
if (is_file($candidate)) return false;
http_response_code(404);
