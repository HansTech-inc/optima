const fs = require('fs').promises
const path = require('path')
import { Cline } from "../Cline"
import { ClineSayTool } from "../../shared/ExtensionMessage"
import { ToolUse, WebSearchToolUse } from "../assistant-message"
import { formatResponse } from "../prompts/responses"
import { AskApproval, HandleError, PushToolResult, RemoveClosingTag } from "./types"
import PCR from "puppeteer-chromium-resolver"
import type { Browser, ElementHandle, Page } from "puppeteer-core"
import { t } from "../../i18n"

interface PuppeteerRequest {
  resourceType(): string
  abort(): Promise<void>
  continue(): Promise<void>
}

interface WebSearchToolMessage extends Pick<ClineSayTool, 'tool'> {
  tool: 'webSearch'
  description: string
  path: string
  query: string
  domain?: string
  maxResults?: number
}

interface WebSearchResult {
  title: string
  url: string
  snippet: string
  content?: string
  codeSnippets?: string[]
  headings?: string[]
}

interface ProcessedResults {
  query: string
  domain?: string
  results: WebSearchResult[]
  keyPhrases: string[]
  searchSummary: string
  timestamp: string
}

interface WebElement {
  textContent: string
  href?: string
}

type ToolMessage = ClineSayTool & {
  tool: "readFile" | "webSearch" | "listFilesTopLevel" | "listFilesRecursive" |
        "listCodeDefinitionNames" | "searchFiles" | "switchMode" | "newTask" | "finishTask"
  description: string
  query?: string
  domain?: string
  maxResults?: number
}

export async function webSearchTool(
  cline: Cline,
  block: ToolUse,
  askApproval: AskApproval,
  handleError: HandleError,
  pushToolResult: PushToolResult,
  removeClosingTag: RemoveClosingTag,
) {
  let browser: Browser | undefined
  
  try {
    // Extract parameters
    const query = removeClosingTag("query", block.params.query)
    const domain = block.params.domain ? removeClosingTag("domain", block.params.domain) : undefined
    const maxResults = block.params.max_results ? parseInt(removeClosingTag("max_results", block.params.max_results)) : 5
    const slidingWindowSize = block.params.sliding_window_size ?
      parseInt(removeClosingTag("sliding_window_size", block.params.sliding_window_size)) : 100
    const chunkDir = block.params.chunk_dir ?
      removeClosingTag("chunk_dir", block.params.chunk_dir) : "./web-search-results"

    // Validate required parameters
    if (!query) {
      cline.consecutiveMistakeCount++
      pushToolResult(await cline.sayAndCreateMissingParamError("web_search", "query"))
      return
    }

    // Format message for approval
    const searchDescription = domain ?
      t("tools:webSearch.withDomain", { query, domain }) :
      t("tools:webSearch.withoutDomain", { query })

    // Create results directory
    const resultsDir = path.resolve(cline.cwd, chunkDir)
    await fs.mkdir(resultsDir, { recursive: true })

    const messageContent: WebSearchToolMessage = {
      tool: "webSearch",
      description: searchDescription,
      path: resultsDir,
      query,
      domain,
      maxResults
    }
    
    const completeMessage = JSON.stringify(messageContent)

    // Get user approval
    const didApprove = await askApproval("tool", completeMessage)
    if (!didApprove) {
      return
    }

    // Initialize browser
    const stats = await PCR({})
    browser = await stats.puppeteer.launch({
      executablePath: stats.executablePath,
      headless: "new",
      args: ["--no-sandbox", "--disable-gpu"]
    })

    const page = await browser.newPage()
    
    // Configure browser
    await page.setRequestInterception(true)
    page.on("request", (request: PuppeteerRequest) => {
      const resourceType = request.resourceType()
      if (resourceType === "image" || resourceType === "stylesheet" || resourceType === "font") {
        request.abort()
      } else {
        request.continue()
      }
    })

    // Perform search
    const searchUrl = domain ?
      `https://www.bing.com/search?q=site:${domain}+${encodeURIComponent(query)}` :
      `https://www.bing.com/search?q=${encodeURIComponent(query)}`
    
    await page.goto(searchUrl, { waitUntil: "networkidle0" })
    
    // Extract search results
    const results: WebSearchResult[] = []
    const searchResults = await page.$$("li.b_algo")
    
    for (let i = 0; i < Math.min(searchResults.length, maxResults); i++) {
      const result = searchResults[i]
      const titleElement = await result.$("h2 a")
      const snippetElement = await result.$(".b_caption p")
      
      if (titleElement && snippetElement) {
        const title = await page.evaluate((el: Element) => el.textContent || "", titleElement)
        const url = await page.evaluate((el: HTMLAnchorElement) => el.href, titleElement)
        const snippet = await page.evaluate((el: Element) => el.textContent || "", snippetElement)
        
        // Visit page and extract content
        try {
          const contentPage = await browser.newPage()
          await contentPage.goto(url, { waitUntil: "networkidle0", timeout: 10000 })
          
          // Extract main content
          const content = await contentPage.evaluate(() => {
            const mainElement = document.querySelector("main, article, .content, #content")
            return mainElement ? mainElement.textContent : document.body.textContent
          })
          
          // Extract code snippets
          const codeSnippets = await contentPage.evaluate(() => {
            return Array.from(document.querySelectorAll("pre, code"))
              .map(el => el.textContent)
              .filter(Boolean)
          })
          
          // Extract headings
          const headings = await contentPage.evaluate(() => {
            return Array.from(document.querySelectorAll("h1, h2, h3"))
              .map(el => el.textContent)
              .filter(Boolean)
          })
          
          results.push({
            title,
            url,
            snippet,
            content,
            codeSnippets,
            headings
          })
          
          await contentPage.close()
          
        } catch (error) {
          console.error(`Error extracting content from ${url}:`, error)
          results.push({ title, url, snippet })
        }
      }
    }

    // Process results
    const timestamp = new Date().toISOString()
    const processedResults: ProcessedResults = {
      query,
      domain,
      results,
      keyPhrases: extractKeyPhrases(results, slidingWindowSize),
      searchSummary: generateSearchSummary(results),
      timestamp
    }

    // Store results
    const resultsPath = path.join(resultsDir, `search-${timestamp}.json`)
    await fs.writeFile(resultsPath, JSON.stringify(processedResults, null, 2))

    // Format output
    const output = formatSearchResults(processedResults, resultsPath)
    pushToolResult(output)

  } catch (error) {
    await handleError("performing web search", error)
  } finally {
    if (browser) {
      await browser.close()
    }
  }
}

function extractKeyPhrases(results: WebSearchResult[], windowSize: number): string[] {
  const phrases = new Set<string>()
  
  for (const result of results) {
    if (!result.content) continue
    
    const words = result.content.split(/\s+/)
    for (let i = 0; i < words.length - windowSize; i++) {
      const phrase = words.slice(i, i + windowSize).join(" ")
      if (phrase.length > 30 && phrase.length < 150) {
        phrases.add(phrase)
      }
    }
  }
  
  return Array.from(phrases).slice(0, 5)
}

function generateSearchSummary(results: WebSearchResult[]): string {
  const summary = results
    .filter(r => r.headings && r.headings.length > 0)
    .map(r => r.headings!.join(" > "))
    .join("\n")
  
  return summary || "No structured summary available"
}

function formatSearchResults(results: ProcessedResults, storagePath: string): string {
  const { query, domain, searchSummary, keyPhrases, results: searchResults } = results
  
  return `Web Search Results for: "${query}"
${domain ? `Domain: ${domain}\n` : ""}
Results stored in: ${storagePath}

Search Summary:
${searchSummary}

Key Phrases:
${keyPhrases.join("\n")}

Results:
${searchResults.map(r => `- ${r.title}
  ${r.url}
  ${r.snippet}
  ${r.codeSnippets?.length ? `\nCode Snippets: ${r.codeSnippets.length} found` : ""}
  ${r.headings?.length ? `\nHeadings: ${r.headings.join(" > ")}` : ""}`).join("\n\n")}`
}
