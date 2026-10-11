import { DB, likeLiteral, nowIso, QUARANTINE_RULE_MATCH } from "./db.js";

export interface QuarantineTarget {
  /** session_id prefix */
  session?: string;
  /** substring of episode content */
  match?: string;
  /** lift the quarantine instead of applying it */
  off?: boolean;
}

/**
 * Hide (or un-hide) episodes from every read surface. Applying it also
 * consumes the unconsumed restoration briefs that could carry the hidden
 * text: a brief is a snapshot written at PreCompact, so one written before
 * the quarantine would otherwise be printed back into a fresh context by the
 * next SessionStart restore. A brief is consumed when its session is being
 * quarantined, when its session holds an episode the match hit, or when the
 * brief text itself contains the match. Lifting the quarantine never
 * un-consumes: a restore is one-shot, and a stale brief is not worth reviving.
 *
 * Applying also persists the target as a rule (see db.ts), so rows ingested
 * later are hidden at insert. Lifting deletes that rule, un-hides the rows it
 * names, then re-hides any of them another remaining rule still covers.
 */
export function quarantine(db: DB, t: QuarantineTarget): { episodes: number; briefs: number } {
  const val = t.off ? 0 : 1;
  return db.transaction(() => {
    let episodes = 0;
    let briefs = 0;
    const consume = (where: string, ...params: unknown[]) =>
      db.prepare(`UPDATE checkpoints SET consumed_at = ? WHERE consumed_at IS NULL AND (${where})`).run(nowIso(), ...params).changes;
    if (t.session) {
      const prefix = likeLiteral(t.session) + "%";
      episodes += db.prepare("UPDATE episodes SET quarantined = ? WHERE session_id LIKE ? ESCAPE '\\'").run(val, prefix).changes;
      if (!t.off) briefs += consume("session_id LIKE ? ESCAPE '\\'", prefix);
    }
    if (t.match) {
      const like = "%" + likeLiteral(t.match) + "%";
      episodes += db.prepare("UPDATE episodes SET quarantined = ? WHERE content LIKE ? ESCAPE '\\'").run(val, like).changes;
      if (!t.off)
        briefs += consume(
          "brief LIKE ? ESCAPE '\\' OR session_id IN (SELECT DISTINCT session_id FROM episodes WHERE content LIKE ? ESCAPE '\\')",
          like,
          like
        );
    }
    const rules: [string, string | undefined][] = [["session", t.session], ["match", t.match]];
    for (const [kind, pattern] of rules) {
      if (pattern === undefined) continue;
      if (t.off) db.prepare("DELETE FROM quarantine_rules WHERE kind = ? AND pattern = ?").run(kind, pattern);
      else db.prepare("INSERT OR IGNORE INTO quarantine_rules (kind, pattern, created_at) VALUES (?, ?, ?)").run(kind, pattern, nowIso());
    }
    if (t.off) {
      // Rows the lifted rule shared with a remaining rule stay hidden.
      episodes -= db
        .prepare(`UPDATE episodes AS e SET quarantined = 1 WHERE quarantined = 0 AND EXISTS (SELECT 1 FROM quarantine_rules r WHERE ${QUARANTINE_RULE_MATCH("e")})`)
        .run().changes;
    }
    return { episodes, briefs };
  })();
}
