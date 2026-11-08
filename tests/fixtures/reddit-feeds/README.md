# Reddit Atom feeds

`projectmanagement-new.atom.xml` is shaped like `https://www.reddit.com/r/<sub>/new/.rss?limit=100` (Atom, one
`<entry>` per post, the body as escaped HTML between `<!-- SC_OFF -->` / `<!-- SC_ON -->` followed by the
"submitted by … [link] [comments]" footer; link posts carry a thumbnail table and no self-text). It was written
by hand from that schema, not fetched: tests never call Reddit. Used by `apps/worker/src/reddit/client.test.ts`
and `apps/worker/src/queues/reddit-poll.test.ts`.
