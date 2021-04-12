const puppeteer = require('puppeteer')
const { URL } = require('url')
const fse = require('fs-extra')
const path = require('path')
const axios = require('axios').default
const url = process.argv[2] || 'http://www.skeans.com/'
let output = './output/' + new URL(url).host + '/'
const workers = 12
require('events').EventEmitter.defaultMaxListeners = 10 * workers
const siteMap = {}
const pages = {}
const fileMap = new Set()
let noNextPageCycles = 0
let currentWorkers = 0
const createSiteGraph = (siteMap) => {
  const edges = []
  for (const [page, value] of Object.entries(siteMap)) {
    for (const pageLinksTo of value) {
      edges.push(`"${page}" -> "${pageLinksTo}";`)
    }
  }
  edges.unshift('digraph {')
  edges.push('}')
  return edges.join('\r\n')
}
const goToNextPage = async () => {
  const nextPage = Object.entries(pages).find((page) => !page[1])
  if (nextPage) {
    noNextPageCycles = 0
    if (currentWorkers <= workers) {
      fetchUrl(nextPage[0])
    }
  } else {
    noNextPageCycles++
  }
  if (noNextPageCycles > 10) {
    clearInterval(interval)
    for (const [key, value] of Object.entries(siteMap)) {
      siteMap[key] = Array.from(value)
    }
    await fse.outputFile(
      path.resolve(`${output}sitemap.json`),
      JSON.stringify(siteMap),
    )
    await fse.outputFile(
      path.resolve(`${output}sitemap.gv`),
      createSiteGraph(siteMap),
    )
    await fse.outputFile(
      path.resolve(`${output}filemap.json`),
      JSON.stringify(Array.from(fileMap)),
    )
  }
}

const getFileName = ({
  contentDispositionHeader = '',
  contentTypeHeader = '',
  filePath = '',
}) => {
  const fileExtensionArray = contentTypeHeader.split('/')
  let fileName = 'index'
  let fileExtension = '.' + fileExtensionArray[fileExtensionArray.length - 1]
  if (fileExtension === '.') {
    fileExtension = '.html'
  }
  if (fileExtension.substring(0, 5) === '.html') {
    fileExtension = '.html'
  }
  if (fileExtension === '.javascript') {
    fileExtension = '.js'
  }
  if (fileExtension === '.x-javascript') {
    fileExtension = '.js'
  }
  if (contentDispositionHeader) {
    const fullFileName = contentDispositionHeader
      .split('=')
      .reduce((_, current) => current)
      .replace(/(^")|("$)/g, '')
    const fileNameObject = fullFileName.split('').reduce(
      (previous, current) => {
        if (current === '.') {
          previous.fileName = [...previous.fileName, ...previous.fileExtension]
          previous.fileExtension = ['.']
          previous.foundDot = true
        } else if (previous.foundDot === true) {
          previous.fileExtension.push(current)
        } else {
          previous.fileName.push(current)
        }
        return previous
      },
      { fileName: [], fileExtension: [], foundDot: false },
    )
    if (fileNameObject.fileName) {
      fileName = fileNameObject.fileName.join('')
    }
    if (fileNameObject.fileExtension) {
      fileExtension = fileNameObject.fileExtension.join('')
    }
  }

  if (filePath.length > 233) {
    filePath = filePath.substring(0, 233)
  }
  if (filePath.length + fileName.length + fileExtension.length > 253) {
    fileName = fileName.substring(
      0,
      253 - fileExtension.length - filePath.length,
    )
  }
  if (fileName === 'index' && !contentTypeHeader.includes('html')) {
    return filePath
  }
  return filePath + '/' + fileName + fileExtension
}

async function fetchUrl(urlToFetch) {
  currentWorkers++
  const currentPage = new URL(urlToFetch)
  pages[currentPage.href] = true

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
      output + currentPage.hostname + currentPage.pathname + currentPage.search,
    )
    let contentDispositionHeader = ''
    let contentTypeHeader = ''
    if (currentPageResponse.headers['content-disposition']) {
      contentDispositionHeader =
        currentPageResponse.headers['content-disposition']
    }
    if (currentPageResponse.headers['content-type']) {
      contentTypeHeader = currentPageResponse.headers['content-type']
    }
    filePath = getFileName({
      contentDispositionHeader,
      contentTypeHeader,
      filePath,
    })
    try {
      await fse.outputFile(filePath, currentPageResponse.data)
    } catch (error) {
      console.error(error)
    }
  } else {
    const browser = await puppeteer.launch({ args: ['--no-sandbox'] })
    const page = await browser.newPage()
    page.setDefaultNavigationTimeout(0)
    try {
      page.on('response', async (response) => {
        const url = new URL(response.url())
        let filePath = path.resolve(
          output + url.hostname + url.pathname + url.search,
        )

        let contentDispositionHeader = ''
        let contentTypeHeader = ''
        if (response.headers()['content-disposition']) {
          contentDispositionHeader = response.headers()['content-disposition']
        }
        if (response.headers()['content-type']) {
          contentTypeHeader = response.headers()['content-type']
        }
        filePath = getFileName({
          contentDispositionHeader,
          contentTypeHeader,
          filePath,
        })

        try {
          if (
            Number(response.status().toString()[0]) !== 3 &&
            !response.request().url().startsWith('data:')
          ) {
            //generating the sitemap
            if (response.request().headers().referer) {
              if (!siteMap[response.request().headers().referer]) {
                siteMap[response.request().headers().referer] = new Set()
              }
              siteMap[response.request().headers().referer].add(
                response.request().url(),
              )
            }
            fileMap.add({
              originalLocation: response.request().url(),
              newLocation: filePath,
            })
            await fse.outputFile(filePath, await response.buffer())
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
        currentWorkers--
      }, 6000)
    }
  }
}
const interval = setInterval(() => {
  goToNextPage()
}, 500)

fetchUrl(url)
