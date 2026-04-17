const YOUTUBE_URL = "https://www.youtube.com/watch?v=I0V14dTS9JQ";

import("./ingestion/youtube.js")
  .then((m) => m.ingest(YOUTUBE_URL))
  .then((r) => console.log(JSON.stringify(r, null, 2)))
  .catch(console.error);
