<?php
declare(strict_types=1);
// {update}: {System.Collections.Hashtable[update]} route handlers.

    if ($method==='PATCH' && preg_match('#^/api/admin/accounts/(\d+)$#',$route,$match)) {
        $actor=requireAdmin($route);$id=(int)$match[1];$data=$getBody();$wanted=$data['role']??'';
        if(!in_array($wanted,['member','admin'],true))fail(400,'Choose Member or Administrator access.');
        if($id===(int)$actor['id'])fail(409,'You cannot change your own administrator access.');
        $account=row('SELECT id,role FROM users WHERE id=?',[$id]);if(!$account)fail(404,'Account not found.');
        $role=$wanted==='admin'?'admin':'buyer';
        if($account['role']==='admin'&&$role!=='admin'&&(int)row("SELECT COUNT(*) total FROM users WHERE role='admin'")['total']<=1)fail(409,'Goodfind must keep at least one administrator account.');
        runSql('UPDATE users SET role=? WHERE id=?',[$role,$id]);answer(200,['id'=>$id,'role'=>$wanted]);
    }

    if ($method==='PATCH' && preg_match('#^/api/admin/verifications/(\d+)$#',$route,$match)) {
        requireAdmin($route); $data=$getBody(); if (!in_array($data['status']??'', ['verified','rejected'], true)) fail(400,'Choose verified or rejected.'); $id=(int)$match[1];
        transaction(static function() use($data,$id){$result=runSql("UPDATE users SET id_verification_status=?,id_photo_data=NULL WHERE id=? AND id_verification_status='pending'",[$data['status'],$id]);if(!$result['changes'])fail(404,'Pending ID verification not found.');runSql('UPDATE listings SET verified=? WHERE seller_id=?',[$data['status']==='verified'?1:0,$id]);});
        answer(200,['id'=>$id,'status'=>$data['status']]);
    }

    if ($method==='PATCH' && preg_match('#^/api/admin/listings/(\d+)$#',$route,$match)) {
        requireAdmin($route); $data=$getBody(); $transitions=['active'=>['pending','hidden'],'hidden'=>['active'],'rejected'=>['pending']]; $status=$data['status']??'';
        if (!isset($transitions[$status])) fail(400,'Choose approve, reject, hide, or restore.'); $from=$transitions[$status]; $marks=implode(',',array_fill(0,count($from),'?'));
        $result=runSql("UPDATE listings SET status=? WHERE id=? AND status IN ({$marks})",[$status,(int)$match[1],...$from]); if(!$result['changes'])fail(404,'Listing review action is no longer available.'); answer(200,['id'=>(int)$match[1],'status'=>$status]);
    }

    if ($method==='PATCH' && preg_match('#^/api/listings/(\\d+)$#',$route,$match)) {
        $user=requireVerified($route);$data=$getBody();$id=(int)$match[1];$title=textValue($data['title']??null,100,'Title');$description=textValue($data['description']??null,2000,'Description',5);$place=textValue($data['place']??null,80,'School community');
        if(!in_array($place,['UM Panabo College','Aces Polytechnic College','Southern Davao National High School'],true))fail(400,'Choose a school community for this listing.');$price=(float)($data['price']??0);if(!is_finite($price)||$price<1||$price>1000000)fail(400,'Price must be between PHP 1 and PHP 1,000,000.');
        $kind=($data['kind']??'')==='digital'?'digital':(($data['kind']??'')==='physical'?'physical':'');if(!$kind)fail(400,'Choose physical or digital goods.');$category=textValue($data['category']??null,60,'Category');$condition=$kind==='digital'?textValue((string)($data['condition']??'Instant download'),40,'Delivery type'):textValue((string)($data['condition']??'Good'),40,'Condition');
        $photos=$data['photosData']??[];if(!is_array($photos)||count($photos)>10)fail(400,'Choose up to 10 item photos.');foreach($photos as $photo)validImage($photo,'item');$cover=$photos[0]??null;$categoryId=ensureCategory($category);$palette=$kind==='digital'?'linear-gradient(140deg,#d6d0f1,#a9a0dc)':'linear-gradient(140deg,#d4e4ce,#a8c6a4)';
        transaction(static function()use($user,$id,$title,$description,$place,$price,$kind,$categoryId,$category,$condition,$photos,$cover,$palette,$data){
            $item=row('SELECT * FROM listings WHERE id=? FOR UPDATE',[$id]);if(!$item||(int)$item['seller_id']!==(int)$user['id']||$item['status']==='deleted')fail(404,'Your listing could not be found.');
            if(!in_array($item['status'],['active','pending','hidden','rejected'],true)||row("SELECT id FROM orders WHERE listing_id=? AND queue_status='approved' LIMIT 1 FOR UPDATE",[$id]))fail(409,'This listing cannot be edited while an exchange is active or completed.');
            runSql("UPDATE listings SET title=?,seller_name=?,initial=?,price_cents=?,kind=?,category_id=?,category=?,`condition`=?,place=?,emoji=?,art=?,photo_data=?,note='AWAITING REVIEW',open_to_trade=?,description=?,status='pending',verified=? WHERE id=?",[$title,$user['display_name'],strtoupper(substr($user['display_name'],0,1)),(int)round($price*100),$kind,$categoryId,$category,$condition,$place,$kind==='digital'?'💾':'✨',$palette,$cover,!empty($data['trade'])?1:0,$description,$user['id_verification_status']==='verified'?1:0,$id]);
            runSql('DELETE FROM listing_photos WHERE listing_id=?',[$id]);foreach(array_slice($photos,1) as $index=>$photo)runSql('INSERT INTO listing_photos(listing_id,photo_order,photo_data) VALUES(?,?,?)',[$id,$index+2,$photo]);
            runSql("UPDATE orders SET queue_status='cancelled',status='cancelled' WHERE listing_id=? AND queue_status='queued'",[$id]);runSql("UPDATE trade_offers SET status='declined',updated_at=? WHERE status='pending' AND (listing_id=? OR offered_listing_id=?)",[nowIso(),$id,$id]);
        });
        $item=row('SELECT l.*,c.category_name FROM listings l LEFT JOIN categories c USING(category_id) WHERE l.id=?',[$id]);answer(200,['listing'=>publicListing($item,true,$photos),'reviewRequired'=>true]);
    }

    if ($method==='PATCH' && $route==='/api/auth/profile') {
        $user=requireUser($route);$data=$getBody();$name=textValue($data['displayName']??null,60,'Full name');$schoolId=strtoupper(textValue($data['schoolId']??null,40,'School ID'));$contact=textValue($data['contactNo']??null,25,'Contact number',7);$id=(int)$user['id'];
        if(row("SELECT 1 FROM users WHERE school_id=? AND id<>? AND school_id<>''",[$schoolId,$id]))fail(409,'That school ID is already in use.');
        $submitted=isset($data['idPhoto'])&&$data['idPhoto']?validImage($data['idPhoto'],'school ID'):null;$changed=$schoolId!==$user['school_id'];
        if($changed&&!$submitted)fail(400,'Upload a clear photo of your new school ID number.');if(in_array($user['id_verification_status']?:'unsubmitted',['unsubmitted','rejected'],true)&&!$submitted)fail(400,'Upload a clear school ID photo to submit it for admin review.');
        $photo=null;if(array_key_exists('profilePhoto',$data)&&$data['profilePhoto']!==null&&$data['profilePhoto']!=='')$photo=validImage($data['profilePhoto'],'profile photo');
        runSql("UPDATE users SET school_id=?,display_name=?,full_name=?,contact_no=?,profile_photo=?,id_photo_data=COALESCE(?,id_photo_data),id_verification_status=CASE WHEN ? IS NOT NULL THEN 'pending' WHEN ? THEN 'unsubmitted' ELSE id_verification_status END WHERE id=?",[$schoolId,$name,$name,$contact,$photo,$submitted,$submitted,$changed?1:0,$id]);
        if($submitted)runSql('UPDATE listings SET verified=0 WHERE seller_id=?',[$id]);runSql('UPDATE listings SET seller_name=?,initial=? WHERE seller_id=?',[$name,strtoupper(substr($name,0,2)),$id]);answer(200,['user'=>safeUser(row('SELECT * FROM users WHERE id=?',[$id]))]);
    }

    if ($method==='PATCH' && preg_match('#^/api/listings/(\d+)/status$#',$route,$match)) {
        $user=requireVerified($route);$data=$getBody();$map=['available'=>'active','reserved'=>'reserved','sold'=>'sold'];$target=$map[$data['status']??'']??null;if(!$target)fail(400,'Choose Available, Reserved, or Sold.');$id=(int)$match[1];
        transaction(static function()use($user,$target,$id){$item=row('SELECT * FROM listings WHERE id=? FOR UPDATE',[$id]);if(!$item||(int)$item['seller_id']!==(int)$user['id'])fail(404,'Your listing could not be found.');if(in_array($item['status'],['hidden','traded','pending','rejected'],true))fail(409,'This listing status can only be changed by its current marketplace process.');$approved=row("SELECT id FROM orders WHERE listing_id=? AND queue_status='approved' LIMIT 1 FOR UPDATE",[$id]);if($approved&&$target==='sold')fail(409,'Complete the approved order to mark this item sold and enable reviews.');if($approved&&$target!=='reserved')fail(409,'This item is reserved for an approved order. Complete or cancel that order first.');runSql('UPDATE listings SET status=? WHERE id=?',[$target,$id]);if($target==='sold')runSql("UPDATE orders SET queue_status='cancelled',status='cancelled' WHERE listing_id=? AND queue_status='queued'",[$id]);});answer(200,['listingId'=>$id,'status'=>$target]);
    }

    if ($method==='PATCH' && preg_match('#^/api/orders/(\d+)$#',$route,$match)) {
        $user=requireUser($route);$data=$getBody();$action=$data['action']??'';if(!in_array($action,['approved','cancelled','completed'],true))fail(400,'Choose Approve, Decline, or Complete exchange.');$id=(int)$match[1];$userId=(int)$user['id'];
        transaction(static function()use($userId,$action,$id){$order=row('SELECT * FROM orders WHERE id=? FOR UPDATE',[$id]);if(!$order)fail(404,'Order request not found.');
            if($action==='approved'){if((int)$order['seller_id']!==$userId)fail(403,'Only the seller can approve this order.');if($order['queue_status']!=='queued')fail(409,'This request is no longer waiting for approval.');$first=row("SELECT id FROM orders WHERE listing_id=? AND queue_status='queued' ORDER BY order_date,id LIMIT 1 FOR UPDATE",[(int)$order['listing_id']]);if(!$first||(int)$first['id']!==$id)fail(409,'Review the earlier queued request first.');$item=row('SELECT * FROM listings WHERE id=? FOR UPDATE',[(int)$order['listing_id']]);if(!$item||(int)$item['seller_id']!==$userId||$item['status']!=='active')fail(409,'This listing is not available to approve.');runSql("UPDATE listings SET status='reserved' WHERE id=? AND status='active'",[(int)$item['id']]);runSql("UPDATE orders SET queue_status='approved',status='pending' WHERE id=? AND queue_status='queued'",[$id]);runSql("UPDATE orders SET queue_status='cancelled',status='cancelled' WHERE listing_id=? AND id<>? AND queue_status='queued'",[(int)$item['id'],$id]);return;}
            if($action==='cancelled'){$buyer=(int)$order['buyer_id']===$userId;$seller=(int)$order['seller_id']===$userId;if(!$buyer&&!$seller)fail(403,'You cannot cancel this order.');$queued=$order['queue_status']==='queued';$approved=$order['queue_status']==='approved'&&!$order['stripe_session_id'];if(!$queued&&!$approved)fail(409,'This order can no longer be cancelled here.');runSql("UPDATE orders SET queue_status='cancelled',status='cancelled' WHERE id=?",[$id]);if($approved)runSql("UPDATE listings SET status='active' WHERE id=? AND seller_id=? AND status='reserved'",[(int)$order['listing_id'],(int)$order['seller_id']]);return;}
            if((int)$order['seller_id']!==$userId)fail(403,'Only the seller can confirm the exchange.');if($order['queue_status']!=='approved')fail(409,'Only an approved order can be completed.');if($order['stripe_session_id'])fail(409,'This order has secure checkout in progress. Wait for payment confirmation before completing it.');$item=row('SELECT * FROM listings WHERE id=? FOR UPDATE',[(int)$order['listing_id']]);if(!$item||(int)$item['seller_id']!==$userId||$item['status']!=='reserved')fail(409,'The reserved listing could not be completed.');runSql("UPDATE orders SET queue_status='completed',status='completed' WHERE id=? AND queue_status='approved'",[$id]);runSql("UPDATE listings SET status='sold' WHERE id=? AND seller_id=? AND status='reserved'",[(int)$item['id'],$userId]);
        });answer(200,['orderId'=>$id,'action'=>$action,'queueStatus'=>$action==='approved'?'approved':($action==='completed'?'completed':'cancelled')]);
    }

    if ($method==='PATCH' && preg_match('#^/api/trades/(\d+)$#',$route,$match)) {
        $user=requireVerified($route);$data=$getBody();$status=$data['status']??'';if(!in_array($status,['accepted','declined','withdrawn'],true))fail(400,'Choose accepted, declined, or withdrawn.');$offerId=(int)$match[1];$userId=(int)$user['id'];
        transaction(static function()use($status,$offerId,$userId){$offer=row('SELECT * FROM trade_offers WHERE id=? FOR UPDATE',[$offerId]);if(!$offer)fail(404,'Trade offer not found.');$allowed=$status==='withdrawn'?(int)$offer['sender_id']===$userId:(int)$offer['receiver_id']===$userId;if(!$allowed)fail(403,'You cannot update this trade offer.');$updated=runSql("UPDATE trade_offers SET status=?,updated_at=? WHERE id=? AND status='pending'",[$status,nowIso(),$offerId]);if(!$updated['changes'])fail(409,'This trade offer has already been answered.');if($status==='accepted'){$wanted=row('SELECT status FROM listings WHERE id=? FOR UPDATE',[(int)$offer['listing_id']]);$offered=row('SELECT status,seller_id FROM listings WHERE id=? FOR UPDATE',[(int)$offer['offered_listing_id']]);if(!$wanted||!$offered||$wanted['status']!=='active'||$offered['status']!=='active'||(int)$offered['seller_id']!==(int)$offer['sender_id'])fail(409,'One of the items is no longer available.');runSql("UPDATE listings SET status='traded' WHERE id IN (?,?)",[(int)$offer['listing_id'],(int)$offer['offered_listing_id']]);runSql("UPDATE orders SET queue_status='cancelled',status='cancelled' WHERE listing_id IN (?,?) AND queue_status='queued'",[(int)$offer['listing_id'],(int)$offer['offered_listing_id']]);runSql("UPDATE trade_offers SET status='declined',updated_at=? WHERE status='pending' AND id<>? AND (listing_id IN (?,?) OR offered_listing_id IN (?,?))",[nowIso(),$offerId,(int)$offer['listing_id'],(int)$offer['offered_listing_id'],(int)$offer['listing_id'],(int)$offer['offered_listing_id']]);}});answer(200,['id'=>$offerId,'status'=>$status]);
    }

