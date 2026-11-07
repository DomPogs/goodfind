<?php
declare(strict_types=1);
// {delete}: {System.Collections.Hashtable[delete]} route handlers.

    if ($method==='DELETE' && preg_match('#^/api/listings/(\d+)$#',$route,$match)) {
        $user=requireUser($route);$id=(int)$match[1];
        transaction(static function()use($user,$id){
            $item=row('SELECT id,seller_id,status FROM listings WHERE id=? FOR UPDATE',[$id]);
            if(!$item||(int)$item['seller_id']!==(int)$user['id'])fail(404,'Your listing could not be found.');
            if($item['status']==='deleted')return;
            if(row("SELECT id FROM orders WHERE listing_id=? AND queue_status='approved' LIMIT 1 FOR UPDATE",[$id]))fail(409,'This item has an approved order. Complete or cancel that order before deleting the listing.');
            runSql("UPDATE orders SET queue_status='cancelled',status='cancelled' WHERE listing_id=? AND queue_status='queued'",[$id]);
            runSql("UPDATE trade_offers SET status='declined',updated_at=? WHERE status='pending' AND (listing_id=? OR offered_listing_id=?)",[nowIso(),$id,$id]);
            runSql("UPDATE listings SET status='deleted' WHERE id=?",[$id]);
        });
        answer(200,['listingId'=>$id,'deleted'=>true]);
    }

