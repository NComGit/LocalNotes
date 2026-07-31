-- orphan-notes.sql — notes with no tags at all.
SELECT *
  FROM notes
 WHERE tag_count = 0
 ORDER BY modified_ts DESC
