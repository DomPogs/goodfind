<?php
declare(strict_types=1);

/* PHP/MySQL API for the XAMPP deployment. The browser keeps its existing JSON API contract. */

final class ApiError extends RuntimeException {
    public int $status;
    public function __construct(int $status, string $message) { parent::__construct($message); $this->status = $status; }
}

$config = [];
$appRoot = dirname(__DIR__);
$envFile = $appRoot . DIRECTORY_SEPARATOR . '.env';
if (is_file($envFile)) {
    foreach (file($envFile, FILE_IGNORE_NEW_LINES) ?: [] as $line) {
        if (preg_match('/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/', $line, $match)) {
            $value = trim($match[2]);
            if (strlen($value) >= 2 && (($value[0] === '"' && substr($value, -1) === '"') || ($value[0] === "'" && substr($value, -1) === "'"))) $value = substr($value, 1, -1);
            $config[$match[1]] = $value;
        }
    }
}

function setting(string $key, string $default = ''): string { global $config; return (string)($config[$key] ?? getenv($key) ?: $default); }
function db(): PDO {
    static $pdo = null;
    if ($pdo instanceof PDO) return $pdo;
    $host = setting('DB_HOST', '127.0.0.1'); $port = setting('DB_PORT', '3306'); $name = setting('DB_NAME', 'youfind');
    $pdo = new PDO("mysql:host={$host};port={$port};dbname={$name};charset=utf8mb4", setting('DB_USER', 'root'), setting('DB_PASSWORD'), [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
    ]);
    return $pdo;
}
function rows(string $sql, array $params = []): array { $stmt = db()->prepare($sql); $stmt->execute($params); return $stmt->fetchAll(); }
function row(string $sql, array $params = []): ?array { $stmt = db()->prepare($sql); $stmt->execute($params); $value = $stmt->fetch(); return $value === false ? null : $value; }
function debugLog(string $event, array $context = []): void {
    if (setting('APP_DEBUG') !== '1') return;
    $record = ['time'=>gmdate('c'),'event'=>$event,'request_id'=>$GLOBALS['requestId'] ?? null] + $context;
    $line = json_encode($record, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    if ($line !== false) @file_put_contents(dirname(__DIR__) . '/logs/api-debug.log', $line . PHP_EOL, FILE_APPEND | LOCK_EX);
}
function runSql(string $sql, array $params = []): array {
    $stmt = db()->prepare($sql); $stmt->execute($params);
    $result = ['changes'=>$stmt->rowCount(), 'id'=>db()->lastInsertId()];
    if (preg_match('/^\s*(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+`?([a-zA-Z0-9_]+)/i', $sql, $match)) {
        debugLog('database_write',['operation'=>strtoupper(preg_replace('/\s+/', ' ', $match[1])),'table'=>$match[2],'rows_affected'=>$result['changes'],'insert_id'=>$result['id']]);
    }
    return $result;
}
function answer(int $status, array $data): void {
    global $requestId, $requestStarted, $route, $method;
    http_response_code($status); header('Content-Type: application/json; charset=utf-8'); header('Cache-Control: no-store'); header('X-Content-Type-Options: nosniff');
    if (!empty($requestId)) header('X-Request-ID: ' . $requestId);
    if (!empty($requestStarted)) debugLog('response', ['request_id'=>$requestId,'method'=>$method ?? '','route'=>$route ?? '','status'=>$status,'duration_ms'=>(int)round((microtime(true)-$requestStarted)*1000)]);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE); exit;
}
function fail(int $status, string $message): void { throw new ApiError($status, $message); }
function nowIso(): string { return gmdate('Y-m-d\TH:i:s') . '.' . sprintf('%03d', (int)((microtime(true) - floor(microtime(true))) * 1000)) . 'Z'; }
function textValue($value, int $max, string $label, int $min = 1): string {
    if (!is_string($value)) fail(400, "{$label} is required.");
    $value = trim($value); $length = function_exists('mb_strlen') ? mb_strlen($value, 'UTF-8') : strlen($value);
    if ($length < $min || $length > $max) fail(400, "{$label} must be {$min}–{$max} characters.");
    return $value;
}
function bodyJson(): array {
    $raw = file_get_contents('php://input');
    if ($raw === false || $raw === '') return [];
    if (stripos($_SERVER['CONTENT_TYPE'] ?? '', 'application/json') === false) fail(415, 'Use application/json for API requests.');
    $data = json_decode($raw, true); if (!is_array($data)) fail(400, 'Request body must be valid JSON.'); return $data;
}
function validImage($value, string $label): string {
    if (!is_string($value) || strlen($value) > 1500000 || !preg_match('/^data:image\/jpeg;base64,([A-Za-z0-9+\/=]+)$/', $value, $match)) fail(400, "Upload a JPG image for {$label}.");
    $bytes = base64_decode($match[1], true);
    if ($bytes === false || strlen($bytes) > 1024 * 1024 || strlen($bytes) < 4 || substr($bytes, 0, 2) !== "\xFF\xD8" || substr($bytes, -2) !== "\xFF\xD9") fail(400, "The {$label} image is invalid or too large.");
    return $value;
}
function safeUser(?array $user): ?array {
    if (!$user) return null;
    return ['id'=>(int)$user['id'],'schoolId'=>$user['school_id'],'displayName'=>$user['full_name'] ?: $user['display_name'],'contactNo'=>$user['contact_no'],'profilePhoto'=>$user['profile_photo'] ?: null,
        'idVerificationStatus'=>$user['id_verification_status'] ?: 'unsubmitted','email'=>$user['email'],'role'=>$user['role'] ?: 'buyer','payoutsConnected'=>(bool)$user['stripe_charges_enabled'] && (bool)$user['stripe_payouts_enabled'],'createdAt'=>$user['created_at']];
}
function publicListing(array $item, bool $includePhotos = false, ?array $photos = null): array {
    $gallery = $photos ?? (!empty($item['photo_data']) ? [$item['photo_data']] : []);
    $out = ['id'=>(int)$item['id'],'sellerId'=>isset($item['seller_id'])?(int)$item['seller_id']:null,'title'=>$item['title'],'seller'=>$item['seller_name'],'initial'=>$item['initial'],'verified'=>(bool)$item['verified'],
        'price'=>(float)$item['price_cents']/100,'kind'=>$item['kind'],'category'=>$item['category_name'] ?? $item['category'],'categoryId'=>(int)$item['category_id'],'condition'=>$item['condition'],'place'=>$item['place'],
        'emoji'=>$item['emoji'],'art'=>$item['art'],'photoData'=>$item['photo_data'] ?: null,'photoCount'=>(int)($item['photo_count'] ?? count($gallery)),'note'=>$item['note'],'trade'=>(bool)$item['open_to_trade'],'description'=>$item['description'],'status'=>$item['status'],'createdAt'=>$item['created_at']];
    if ($includePhotos) $out['photosData'] = $gallery;
    return $out;
}
function requestUser(string $route): ?array {
    $admin = str_starts_with($route, '/api/admin/'); $name = $admin ? 'goodfind_admin_session' : 'goodfind_session'; $token = $_COOKIE[$name] ?? '';
    if (!$token) return null;
    return row('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?', [hash('sha256', $token), (int)round(microtime(true) * 1000)]);
}
function requireUser(string $route): array { $user = requestUser($route); if (!$user) fail(401, 'Sign in to continue.'); return $user; }
function requireVerified(string $route): array { $user=requireUser($route); if ($user['role'] !== 'admin' && $user['id_verification_status'] !== 'verified') fail(403, 'Verify your school ID before listing, ordering, or trading.'); return $user; }
function requireAdmin(string $route): array { $user=requireUser($route); if ($user['role'] !== 'admin') fail(403, 'Admin access is required.'); return $user; }
function setSession(array $user, bool $admin = false): void {
    $token = rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '='); $expiry = (int)round(microtime(true) * 1000) + 30 * 86400000;
    runSql('DELETE FROM sessions WHERE expires_at<?', [(int)round(microtime(true) * 1000)]);
    runSql('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)', [hash('sha256', $token), (int)$user['id'], $expiry, nowIso()]);
    setcookie($admin ? 'goodfind_admin_session' : 'goodfind_session', $token, ['expires'=>time()+30*86400,'path'=>'/','httponly'=>true,'samesite'=>'Lax','secure'=>(!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')]);
}
function clearSession(string $route): void {
    $admin = str_starts_with($route, '/api/admin/'); $name = $admin ? 'goodfind_admin_session' : 'goodfind_session'; $token = $_COOKIE[$name] ?? '';
    if ($token) runSql('DELETE FROM sessions WHERE token_hash=?', [hash('sha256', $token)]);
    setcookie($name, '', ['expires'=>time()-3600,'path'=>'/','httponly'=>true,'samesite'=>'Lax','secure'=>(!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')]);
}
function ensureCategory(string $category): int {
    runSql('INSERT IGNORE INTO categories(category_name,description) VALUES(?,?)', [$category, '']);
    $found = row('SELECT category_id FROM categories WHERE category_name=?', [$category]); return (int)$found['category_id'];
}
function transaction(callable $callback) {
    $pdo=db(); $pdo->beginTransaction();
    try { $result=$callback(); $pdo->commit(); return $result; }
    catch (Throwable $error) { if ($pdo->inTransaction()) $pdo->rollBack(); throw $error; }
}
function sameOrigin(): void {
    $origin = $_SERVER['HTTP_ORIGIN'] ?? ''; if ($origin === '') return;
    $app=parse_url(setting('APP_URL','http://localhost/goodfind'));
    $expected=($app['scheme']??'http').'://'.($app['host']??'localhost').(isset($app['port'])?':'.$app['port']:'');
    $allowed=[$expected];
    if (($app['scheme']??'http')==='http' && in_array($app['host']??'localhost',['localhost','127.0.0.1','::1'],true)) $allowed=array_merge($allowed,['http://localhost','http://127.0.0.1','http://localhost:3000','http://127.0.0.1:3000','http://localhost:3001','http://127.0.0.1:3001']);
    if (!in_array($origin,$allowed,true)) fail(403, 'This request origin is not allowed.');
}
function deriveScrypt(string $password, string $saltHex, int $n, int $r, int $p): string {
    $binary = setting('OPENSSL_BIN', 'C:\\xampp\\apache\\bin\\openssl.exe');
    if (!is_file($binary)) $binary = 'openssl';
    // OpenSSL 3's scrypt KDF control name is lowercase `n` on the XAMPP build.
    $command=[$binary,'kdf','-binary','-keylen','64','-kdfopt','hexsalt:'.$saltHex,'-kdfopt','pass:'.$password,'-kdfopt','n:'.$n,'-kdfopt','r:'.$r,'-kdfopt','p:'.$p,'-kdfopt','maxmem_bytes:67108864','SCRYPT'];
    $pipes=[]; $proc=@proc_open($command,[0=>['pipe','r'],1=>['pipe','w'],2=>['pipe','w']],$pipes);
    if (!is_resource($proc)) fail(503, 'Password hashing is unavailable. Configure OPENSSL_BIN for the XAMPP OpenSSL executable.');
    fclose($pipes[0]); $derived=stream_get_contents($pipes[1]); fclose($pipes[1]); $error=stream_get_contents($pipes[2]); fclose($pipes[2]); $code=proc_close($proc);
    if ($code !== 0 || strlen($derived) !== 64) fail(503, 'Password hashing failed. Check the XAMPP OpenSSL SCRYPT support.');
    return $derived;
}
function stripeReady(): int {
    $bps=setting('PLATFORM_FEE_BPS');
    if (!setting('STRIPE_SECRET_KEY') || !setting('STRIPE_WEBHOOK_SECRET')) fail(503, 'Payments are not configured yet. Add Stripe test keys and restart Apache.');
    if ($bps === '' || !ctype_digit($bps) || (int)$bps > 10000) fail(503, 'Set PLATFORM_FEE_BPS between 0 and 10000 before enabling checkout.');
    return (int)$bps;
}
function stripeCall(string $method, string $endpoint, array $params = []): array {
    if (!function_exists('curl_init')) fail(503, 'The PHP cURL extension is required for Stripe payments.');
    $curl=curl_init('https://api.stripe.com/v1/'.$endpoint); curl_setopt_array($curl,[CURLOPT_RETURNTRANSFER=>true,CURLOPT_USERPWD=>setting('STRIPE_SECRET_KEY').':',CURLOPT_TIMEOUT=>20]);
    if ($method==='POST') { curl_setopt($curl,CURLOPT_POST,true); curl_setopt($curl,CURLOPT_POSTFIELDS,http_build_query($params)); }
    $raw=curl_exec($curl); $status=(int)curl_getinfo($curl,CURLINFO_RESPONSE_CODE); $error=curl_error($curl); curl_close($curl);
    if ($raw===false) fail(502, $error ?: 'The payment provider could not complete the request.');
    $data=json_decode($raw,true) ?: []; if ($status<200 || $status>=300) fail(502, $data['error']['message'] ?? 'The payment provider could not complete the request.'); return $data;
}

$requestId=bin2hex(random_bytes(8));
$requestStarted=microtime(true);
$route=(string)($_GET['route'] ?? '');
$method=strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
try {
    $configuredAdmin=strtolower(trim(setting('ADMIN_EMAIL')));
    if ($configuredAdmin!=='') runSql("UPDATE users SET role='admin' WHERE email=? AND role<>'admin'",[$configuredAdmin]);
    if ($method !== 'GET' && $route !== '/api/payments/stripe-webhook') sameOrigin();
    if ($method==='OPTIONS') { header('Allow: GET, POST, PATCH, DELETE, OPTIONS'); http_response_code(204); exit; }
    $body=null;
    $getBody=static function() use (&$body): array { if ($body===null) $body=bodyJson(); return $body; };
    $handlerFiles = ['GET'=>'read.php', 'POST'=>'create.php', 'PATCH'=>'update.php', 'DELETE'=>'delete.php'];
    if (!isset($handlerFiles[$method])) answer(405,['error'=>'HTTP method not allowed.']);
    require __DIR__ . '/crud/' . $handlerFiles[$method];
    answer(404,['error'=>'API route not found.']);
} catch (ApiError $error) { answer($error->status,['error'=>$error->getMessage(),'requestId'=>$requestId]); }
catch (Throwable $error) {
    debugLog('exception',['request_id'=>$requestId,'method'=>$method,'route'=>$route,'class'=>get_class($error),'message'=>$error->getMessage()]);
    error_log('[Goodfind PHP API]['.$requestId.'] '.$error->getMessage());
    answer(500,['error'=>'Internal server error.','requestId'=>$requestId]);
}


