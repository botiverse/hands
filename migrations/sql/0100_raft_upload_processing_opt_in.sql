-- "Upload processing" Raft notices become opt-in. Existing Raft destinations
-- were created with every event selected, so drop testflight:upload_processing
-- from them (and from their internal webhook rows) unless it is their only
-- event. Generic webhooks are left as configured.
UPDATE webhooks
SET events_json = (SELECT json_group_array(value) FROM json_each(webhooks.events_json)
                   WHERE value <> 'testflight:upload_processing'),
    updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE id IN (SELECT webhook_id FROM raft_notification_subscriptions WHERE webhook_id IS NOT NULL)
  AND json_valid(events_json)
  AND EXISTS (SELECT 1 FROM json_each(webhooks.events_json) WHERE value = 'testflight:upload_processing')
  AND EXISTS (SELECT 1 FROM json_each(webhooks.events_json) WHERE value <> 'testflight:upload_processing');

UPDATE raft_notification_subscriptions
SET events_json = (SELECT json_group_array(value) FROM json_each(raft_notification_subscriptions.events_json)
                   WHERE value <> 'testflight:upload_processing'),
    updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE json_valid(events_json)
  AND EXISTS (SELECT 1 FROM json_each(raft_notification_subscriptions.events_json) WHERE value = 'testflight:upload_processing')
  AND EXISTS (SELECT 1 FROM json_each(raft_notification_subscriptions.events_json) WHERE value <> 'testflight:upload_processing');
