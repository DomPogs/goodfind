<?php
declare(strict_types=1);
// {read}: {System.Collections.Hashtable[read]} route handlers.

    if ($method==='GET' && $route==='/api/health') answer(200,['ok'=>true,'paymentsConfigured'=>stripeConfigured(),'storage'=>'mysql','runtime'=>'php']);


    if ($method==='GET' && $route==='/api/admin/me') { $user=requestUser($route); answer(200,['user'=>($user && $user['role']==='admin')?safeUser($user):null]); }

    if ($method==='GET' && $route==='/api/admin/overview') {
        requireAdmin($route);
        $counts=['members'=>(int)row('SELECT COUNT(*) n FROM users')['n'],'activeListings'=>(int)row("SELECT COUNT(*) n FROM listings WHERE status='active'")['n'],'hiddenListings'=>(int)row("SELECT COUNT(*) n FROM listings WHERE status='hidden'")['n'],'pendingListings'=>(int)row("SELECT COUNT(*) n FROM listings WHERE status='pending'")['n'],'orders'=>(int)row('SELECT COUNT(*) n FROM orders')['n']];
        $counts['pendingVerifications']=(int)row("SELECT COUNT(*) n FROM users WHERE id_verification_status='pending'")['n'];
        $list=rows("SELECT l.*,c.category_name FROM listings l LEFT JOIN categories c USING(category_id) WHERE l.status IN ('pending','active','hidden','rejected','reserved','sold','traded') ORDER BY CASE WHEN l.status='pending' THEN 0 ELSE 1 END,l.created_at DESC LIMIT 200");
        answer(200,['counts'=>$counts,'listings'=>array_map('publicListing',$list)]);
    }

    if ($method==='GET' && $route==='/api/admin/accounts') {
        requireAdmin($route);
        $accounts=rows("SELECT id,full_name,email,school_id,role,id_verification_status,created_at FROM users ORDER BY created_at DESC,id DESC LIMIT 500");
        answer(200,['accounts'=>array_map(static fn($account)=>['id'=>(int)$account['id'],'name'=>$account['full_name'],'email'=>$account['email'],'schoolId'=>$account['school_id'],'role'=>$account['role'],'verification'=>$account['id_verification_status'],'createdAt'=>$account['created_at']],$accounts)]);
    }

    if ($method==='GET' && $route==='/api/admin/verifications') {
        requireAdmin($route); $list=rows("SELECT id,full_name,email,school_id,id_photo_data,created_at FROM users WHERE id_verification_status='pending' ORDER BY created_at");
        answer(200,['verifications'=>array_map(static fn($u)=>['id'=>(int)$u['id'],'fullName'=>$u['full_name'],'email'=>$u['email'],'schoolId'=>$u['school_id'],'idPhoto'=>$u['id_photo_data'],'submittedAt'=>$u['created_at']],$list)]);
    }

    if ($method==='GET' && $route==='/api/listings') {
        $list=rows("SELECT l.*,c.category_name,(IF(l.photo_data IS NULL,0,1)+(SELECT COUNT(*) FROM listing_photos p WHERE p.listing_id=l.id)) photo_count FROM listings l LEFT JOIN categories c USING(category_id) WHERE l.status='active' ORDER BY l.created_at DESC");
        answer(200,['listings'=>array_map('publicListing',$list)]);
    }

    if ($method==='GET' && preg_match('#^/api/listings/(\d+)$#',$route,$match)) {
        $item=row("SELECT l.*,c.category_name,(IF(l.photo_data IS NULL,0,1)+(SELECT COUNT(*) FROM listing_photos p WHERE p.listing_id=l.id)) photo_count FROM listings l LEFT JOIN categories c USING(category_id) WHERE l.id=? AND l.status='active'",[(int)$match[1]]);
        if(!$item)fail(404,'This listing is no longer available.');$extra=rows('SELECT photo_data FROM listing_photos WHERE listing_id=? ORDER BY photo_order',[(int)$match[1]]);$photos=array_merge($item['photo_data']?[$item['photo_data']]:[],array_column($extra,'photo_data'));answer(200,['listing'=>publicListing($item,true,$photos)]);
    }

    if ($method==='GET' && $route==='/api/auth/me') answer(200,['user'=>safeUser(requestUser($route))]);

    if ($method==='GET' && $route==='/api/auth/listings') {
        $user=requireUser($route);$limit=isset($_GET['all'])&&$_GET['all']==='1'?'':' LIMIT 6';
        $list=rows("SELECT l.id,l.title,l.status,l.price_cents,l.category,l.emoji,l.art,l.photo_data,l.created_at FROM listings l WHERE l.seller_id=? AND l.status<>'deleted' ORDER BY l.created_at DESC,l.id DESC{$limit}",[(int)$user['id']]);
        answer(200,['listings'=>array_map(static fn($x)=>['id'=>(int)$x['id'],'title'=>$x['title'],'status'=>$x['status'],'price'=>(float)$x['price_cents']/100,'category'=>$x['category'],'emoji'=>$x['emoji'],'art'=>$x['art'],'photoData'=>$x['photo_data']?:null,'createdAt'=>$x['created_at']],$list)]);
    }

    if ($method==='GET' && preg_match('#^/api/auth/listings/(\\d+)$#',$route,$match)) {
        $user=requireUser($route);$id=(int)$match[1];
        $item=row("SELECT l.*,c.category_name,(IF(l.photo_data IS NULL,0,1)+(SELECT COUNT(*) FROM listing_photos p WHERE p.listing_id=l.id)) photo_count FROM listings l LEFT JOIN categories c USING(category_id) WHERE l.id=? AND l.seller_id=? AND l.status<>'deleted'",[$id,(int)$user['id']]);
        if(!$item)fail(404,'Your listing could not be found.');$extra=rows('SELECT photo_data FROM listing_photos WHERE listing_id=? ORDER BY photo_order',[$id]);$photos=array_merge($item['photo_data']?[$item['photo_data']]:[],array_column($extra,'photo_data'));answer(200,['listing'=>publicListing($item,true,$photos)]);
    }


    if ($method==='GET' && $route==='/api/orders') {
        $user=requireUser($route);$id=(int)$user['id'];
        $list=rows("SELECT o.id,o.listing_id,o.buyer_id,o.seller_id,o.order_date,o.queue_status,o.amount_cents,o.currency,o.status,o.stripe_session_id,
            l.title,l.status listing_status,l.photo_data,l.emoji,l.art,b.display_name buyer_name,s.display_name seller_name,s.stripe_account_id seller_stripe_account,s.stripe_charges_enabled seller_charges_enabled,s.stripe_payouts_enabled seller_payouts_enabled,
            CASE WHEN o.queue_status='queued' THEN (SELECT COUNT(*) FROM orders q WHERE q.listing_id=o.listing_id AND q.queue_status='queued' AND (q.order_date<o.order_date OR (q.order_date=o.order_date AND q.id<=o.id))) ELSE NULL END queue_position,
            EXISTS(SELECT 1 FROM reviews r WHERE r.order_id=o.id AND r.reviewer_id=?) has_review
            FROM orders o JOIN listings l ON l.id=o.listing_id JOIN users b ON b.id=o.buyer_id JOIN users s ON s.id=o.seller_id WHERE o.buyer_id=? OR o.seller_id=? ORDER BY o.order_date DESC,o.id DESC",[$id,$id,$id]);
        $reviewMap=[];if($list){$ids=array_map(static fn($o)=>(int)$o['id'],$list);$marks=implode(',',array_fill(0,count($ids),'?'));$reviews=rows("SELECT r.order_id,r.reviewer_id,r.rating,r.remarks,r.created_at,u.display_name reviewer_name FROM reviews r JOIN users u ON u.id=r.reviewer_id WHERE r.order_id IN ({$marks}) ORDER BY r.created_at",$ids);foreach($ids as $reviewId)$reviewMap[$reviewId]=[];foreach($reviews as $r)$reviewMap[(int)$r['order_id']][]=['reviewerId'=>(int)$r['reviewer_id'],'reviewerName'=>$r['reviewer_name'],'rating'=>(int)$r['rating'],'remarks'=>$r['remarks'],'createdAt'=>$r['created_at']];}
        $paymentsConfigured=stripeConfigured();
        $orders=array_map(static function($o)use($id,$reviewMap,$paymentsConfigured){$seller=(int)$o['seller_id']===$id;return ['id'=>(int)$o['id'],'listingId'=>(int)$o['listing_id'],'buyerId'=>(int)$o['buyer_id'],'sellerId'=>(int)$o['seller_id'],'buyerName'=>$o['buyer_name'],'sellerName'=>$o['seller_name'],'otherName'=>$seller?$o['buyer_name']:$o['seller_name'],'myRole'=>$seller?'seller':'buyer','itemTitle'=>$o['title'],'itemStatus'=>$o['listing_status'],'itemPhoto'=>$o['photo_data']?:null,'itemEmoji'=>$o['emoji'],'itemArt'=>$o['art'],'date'=>$o['order_date'],'queueStatus'=>$o['queue_status'],'queuePosition'=>$o['queue_position']===null?null:(int)$o['queue_position'],'status'=>$o['status'],'amount'=>(float)$o['amount_cents']/100,'currency'=>$o['currency'],'hasReviewed'=>(bool)$o['has_review'],'reviews'=>$reviewMap[(int)$o['id']]??[],'hasPaymentSession'=>(bool)$o['stripe_session_id'],'paymentReady'=>$paymentsConfigured&&(bool)$o['seller_stripe_account']&&(bool)$o['seller_charges_enabled']&&(bool)$o['seller_payouts_enabled']];},$list);
        $items=rows("SELECT l.id,l.title,l.status,l.price_cents,(SELECT COUNT(*) FROM orders o WHERE o.listing_id=l.id AND o.queue_status='queued') queued_count,(SELECT COUNT(*) FROM orders o WHERE o.listing_id=l.id AND o.queue_status='approved') approved_count FROM listings l WHERE l.seller_id=? AND l.status<>'deleted' ORDER BY l.created_at DESC",[$id]);
        answer(200,['orders'=>$orders,'myListings'=>array_map(static fn($x)=>['id'=>(int)$x['id'],'title'=>$x['title'],'status'=>$x['status'],'price'=>(float)$x['price_cents']/100,'queuedCount'=>(int)$x['queued_count'],'approvedCount'=>(int)$x['approved_count']],$items)]);
    }

    if ($method==='GET' && $route==='/api/trades') {
        $user=requireUser($route);$id=(int)$user['id'];$offers=rows('SELECT t.*,a.title requested_title,a.price_cents requested_price,b.title offered_title,b.price_cents offered_price,u.display_name sender_name,v.display_name receiver_name FROM trade_offers t JOIN listings a ON a.id=t.listing_id JOIN listings b ON b.id=t.offered_listing_id JOIN users u ON u.id=t.sender_id JOIN users v ON v.id=t.receiver_id WHERE t.sender_id=? OR t.receiver_id=? ORDER BY t.created_at DESC',[$id,$id]);
        answer(200,['offers'=>array_map(static fn($o)=>['id'=>(int)$o['id'],'requestedTitle'=>$o['requested_title'],'requestedPrice'=>(float)$o['requested_price']/100,'offeredTitle'=>$o['offered_title'],'offeredPrice'=>(float)$o['offered_price']/100,'sender'=>$o['sender_name'],'receiver'=>$o['receiver_name'],'isIncoming'=>(int)$o['receiver_id']===(int)$user['id'],'note'=>$o['note'],'status'=>$o['status'],'createdAt'=>$o['created_at']],$offers)]);
    }

    if ($method==='GET' && $route==='/api/messages') {
        $user=requireUser($route);$id=(int)$user['id'];$list=rows("SELECT m.listing_id,l.title,l.emoji,l.art,CASE WHEN m.sender_id=? THEN m.receiver_id ELSE m.sender_id END other_id,MAX(CASE WHEN m.sender_id=? THEN b.display_name ELSE a.display_name END) other_name,MAX(m.id) last_id,MAX(m.created_at) last_at,SUBSTRING_INDEX(GROUP_CONCAT(m.sender_id ORDER BY m.id DESC),',',1) last_sender_id FROM messages m JOIN listings l ON l.id=m.listing_id JOIN users a ON a.id=m.sender_id JOIN users b ON b.id=m.receiver_id WHERE m.sender_id=? OR m.receiver_id=? GROUP BY m.listing_id,other_id,l.title,l.emoji,l.art ORDER BY last_id DESC",[$id,$id,$id,$id]);
        answer(200,['conversations'=>array_map(static fn($m)=>['listingId'=>(int)$m['listing_id'],'title'=>$m['title'],'emoji'=>$m['emoji'],'art'=>$m['art'],'otherId'=>(int)$m['other_id'],'otherName'=>$m['other_name'],'lastId'=>(int)$m['last_id'],'lastSenderId'=>(int)$m['last_sender_id'],'lastAt'=>$m['last_at']],$list)]);
    }

    if (preg_match('#^/api/listings/(\d+)/messages$#',$route,$match) && $method==='GET') {
        $user=requireUser($route);$listingId=(int)$match[1];$item=row('SELECT * FROM listings WHERE id=?',[$listingId]);if(!$item)fail(404,'Listing not found.');if(!$item['seller_id'])fail(400,'Messages are available for member listings.');$sellerId=(int)$item['seller_id'];$userId=(int)$user['id'];$isSeller=$userId===$sellerId;$otherId=$isSeller?(int)($_GET['with']??0):$sellerId;if(!$otherId||$otherId===$userId)fail(400,'Choose a conversation member.');
        if($item['status']==='reserved'){$order=row("SELECT 1 FROM orders WHERE listing_id=? AND queue_status='approved' AND buyer_id=? AND seller_id=?",[$listingId,$isSeller?$otherId:$userId,$isSeller?$userId:$otherId]);if(!$order)fail(403,'Only members in the approved order can message about this reserved item.');}
        if($isSeller&&!row('SELECT 1 FROM messages WHERE listing_id=? AND ((sender_id=? AND receiver_id=?) OR (sender_id=? AND receiver_id=?))',[$listingId,$userId,$otherId,$otherId,$userId]))fail(403,'That conversation has not been started.');
        $messages=rows('SELECT m.id,m.body,m.created_at,m.sender_id,u.display_name sender_name FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.listing_id=? AND ((m.sender_id=? AND m.receiver_id=?) OR (m.sender_id=? AND m.receiver_id=?)) ORDER BY m.id',[$listingId,$userId,$otherId,$otherId,$userId]);answer(200,['messages'=>array_map(static fn($m)=>['id'=>(int)$m['id'],'body'=>$m['body'],'createdAt'=>$m['created_at'],'senderId'=>(int)$m['sender_id'],'sender'=>$m['sender_name'],'mine'=>(int)$m['sender_id']===$userId],$messages)]);
    }

    if ($method==='GET' && $route==='/api/payments/connect/status') {
        $user=requireUser($route);if(!$user['stripe_account_id']||!setting('STRIPE_SECRET_KEY'))answer(200,['connected'=>false]);$account=stripeCall('GET','accounts/'.rawurlencode($user['stripe_account_id']));runSql('UPDATE users SET stripe_charges_enabled=?,stripe_payouts_enabled=? WHERE id=?',[!empty($account['charges_enabled'])?1:0,!empty($account['payouts_enabled'])?1:0,(int)$user['id']]);answer(200,['connected'=>!empty($account['charges_enabled'])&&!empty($account['payouts_enabled'])]);
    }

