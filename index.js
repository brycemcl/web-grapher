const workers = 12
const output = './output/'
const tempOutput = './.output/'
const url = 'http://www.skeans.com/'

const puppeteer = require('puppeteer')
const { URL } = require('url')
const fse = require('fs-extra')
const path = require('path')
const axios = require('axios').default

const pages = {}
const href = new Set()
let noNextPageCycles = 0
let currentWorkers = 0

require('events').EventEmitter.defaultMaxListeners = 10 * workers
const goToNextPage = () => {
  const nextPage = Object.entries(pages).find((page) => !page[1])
  if (nextPage) {
    noNextPageCycles = 0
    if (currentWorkers <= workers) {
      fetchUrl(nextPage[0])
    }
  } else {
    noNextPageCycles++
  }
  if (noNextPageCycles > 1000) {
    clearInterval(interval)
  }
}
async function fetchUrl(urlToFetch) {
  currentWorkers++
  const currentPage = new URL(urlToFetch)
  pages[currentPage.href] = true
  href.add(urlToFetch)

  console.log(urlToFetch)

  const currentPageResponse = await axios({
    url: urlToFetch,
    method: 'GET',
    responseType: 'arraybuffer',
  }).catch((e) => e)
  if (
    currentPageResponse.headers &&
    currentPageResponse.headers['content-type'] === 'application/pdf'
  ) {
    let filePath = path.resolve(
      `${tempOutput}${
        currentPage.hostname + currentPage.pathname + currentPage.search
      }`,
    )
    if (currentPageResponse.headers['content-disposition']) {
      const contentDisposition = currentPageResponse.headers[
        'content-disposition'
      ].split('attachment; filename=')[1]
      filePath = `${filePath}/${contentDisposition}`
    }
    try {
      await fse.outputFile(filePath, currentPageResponse.data)
    } catch (error) {
      console.error(error)
    }
    // goToNextPage()
  } else {
    const browser = await puppeteer.launch({ args: ['--no-sandbox'] })
    const page = await browser.newPage()
    try {
      page.on('response', async (response) => {
        const url = new URL(response.url())
        href.add(url.href)
        let filePath = path.resolve(
          `${tempOutput}${url.hostname + url.pathname + url.search}`,
        )
        if (url.hostname === 'image') {
          console.log('hostname')
          console.log(url)
        }
        if (url.pathname === 'image') {
          console.log('pathname')
          console.log(url)
        }
        if (path.extname(url.pathname).trim() === '') {
          filePath = `${filePath}/index.html`
        }
        try {
          if (Number(response.status().toString()[0]) !== 3) {
            await fse.outputFile(
              filePath.substring(0, 254),
              await response.buffer(),
            )
          }
        } catch (error) {
          console.error(error)
        }
      })

      await page.goto(urlToFetch, {
        waitUntil: 'networkidle0',
      })
    } catch (error) {
      console.error(error)
    } finally {
      const links = await page.evaluate(() =>
        Array.from(document.querySelectorAll('a')).map((a) => a.href),
      )

      links.forEach((link) => {
        try {
          const href = new URL(link)
          if (href.host === currentPage.host && !pages[href.href]) {
            pages[href.href] = false
          }
        } catch {}
      })
      setTimeout(async () => {
        browser.close()
        // goToNextPage()
        currentWorkers--
        await fse.outputFile(
          path.resolve(`${tempOutput}pages.json`),
          JSON.stringify(JSON.stringify(Array.from(href))),
        )
      }, 6000)
    }
  }
}
const interval = setInterval(() => {
  goToNextPage()
}, 500)

fetchUrl(url)
