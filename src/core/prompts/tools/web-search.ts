import { ToolArgs } from "./types"

export function getWebSearchDescription(args: ToolArgs): string {
  return `## web_search
Description: Request to search the web for information using configurable parameters. The search is performed through a headless browser and returns analyzed, structured results that include relevant excerpts, code snippets, and summaries from the searched pages.
Parameters:
- query: (required) The search query to execute
- domain: (optional) Domain to restrict the search to (e.g. 'stackoverflow.com')
- max_results: (optional) Maximum number of search results to process (default: 5)
- sliding_window_size: (optional) Size of the sliding window for text analysis (default: 100)
- chunk_dir: (optional) Directory to store chunked results (default: './web-search-results')
Usage:
<web_search>
<query>Your search query here</query>
<domain>Optional domain restriction</domain>
<max_results>Optional max results number</max_results>
<sliding_window_size>Optional window size</sliding_window_size>
<chunk_dir>Optional results directory</chunk_dir>
</web_search>

Examples:

1. Basic search:
<web_search>
<query>typescript async await best practices</query>
</web_search>

2. Domain-restricted search with max results:
<web_search>
<query>react hooks patterns</query>
<domain>dev.to</domain>
<max_results>10</max_results>
</web_search>

3. Advanced search with all parameters:
<web_search>
<query>nodejs stream processing large files</query>
<domain>stackoverflow.com</domain>
<max_results>15</max_results>
<sliding_window_size>200</sliding_window_size>
<chunk_dir>./search-results/nodejs-streams</chunk_dir>
</web_search>`
}