const util = require('util')

const Trie = require('merkle-patricia-tree')
const Levelup = require('levelup')
const Redisdown = require('redisdown')

const { ConcurrentError } = require('./errors')
const { getNextStreamId, objectify, getNewRedisClient, execOperations } = require('./redis')
const { random } = require('./utils')

const recordStream = 'record.stream'
const blockStream = 'block.stream'
const blockPendingStream = 'block.pending.stream'
const blockLedgerIdByIndexKeyFormat = 'block.index.%s'
const blockLedgerIdByRootKeyFormat = 'block.root.%s'

const previousKey = 'previous'
const seedKey = 'seed'

const blockResponse = (block) => {
  return block && {
    root: block.root,
    index: block.index,
    timestamp: block.timestamp,
    count: block.count,
    previous: block.previous,
    records: block.records
  }
}

const parseBlockFromStream = async (result) => {
  return result && JSON.parse(result[1][1])
}

const getBlockInfo = async (redis, streamId) => {
  return parseBlockFromStream((await redis.xrevrange(blockStream, streamId, '-', 'COUNT', 1))[0])
}

const getLastBlockInfo = async (redis) => {
  return getBlockInfo(redis, '+')
}

const getNextBlockInfo = async (redis, timestamp) => {
  return parseBlockFromStream((await redis.xrange(blockStream, timestamp, '+', 'COUNT', 1))[0])
}

const getLastTodoStreamId = async (redis) => {
  const result = (await redis.xrevrange(recordStream, '+', '-', 'COUNT', 1))[0]
  return result ? result[0] : null
}

const getNewBlock = async (redis) => {
  const previousBlock = await getLastBlockInfo(redis)
  let index = 0
  let previous = null
  let streamId = null
  if (previousBlock) {
    index = previousBlock.index + 1
    previous = previousBlock.root
    streamId = previousBlock.streamId
  }
  const location = random(32)
  const blockPendingStreamId = await redis.xadd(blockPendingStream, '*', 'index', index, 'location', location)
  return {
    index,
    streamId,
    location,
    blockPendingStreamId,
    previous,
    timestamp: blockPendingStreamId.split('-')[0],
    trie: new Trie(Levelup(Redisdown(location), {
      host: redis.options.host,
      port: redis.options.port
    })),
    count: 0
  }
}

const cleanBlocks = (redis) => {
  return new Promise((resolve, reject) => {
    setTimeout(async function clean() {
      try {
        const results = await redis.xrange(blockPendingStream, '0', '+', 'COUNT', '1')
        if (results.length === 0) {
          return resolve()
        }
        const blockPendingStreamId = results[0][0]
        const block = objectify(results[0][1])
        const blockLedgerStreamId = await redis.get(util.format(blockLedgerIdByIndexKeyFormat, block.index))
        if (blockLedgerStreamId === null) {
          return resolve()
        }
        const persistedBlock = await getBlockInfo(redis, blockLedgerStreamId)
        if (persistedBlock.location !== block.location) {
          await new Promise((resolve, reject) => {
            Redisdown.destroy(block.location, {
              host: redis.options.host,
              port: redis.options.port
            }, (e) => {
              try {
                if (e) {
                  reject(e)
                } else {
                  resolve(true)
                }
              } catch (e) {
                reject(e)
              }
            })
          })
        }
        await redis.xdel(blockPendingStream, blockPendingStreamId)
        setTimeout(clean, 0)
      } catch (e) {
        reject(e)
      }
    }, 0)
  })
}

const prove = async (trie, root, key) => {
  return new Promise((resolve, reject) => {
    trie.get(key, (e) => {
      try {
        if (e) {
          return reject(e)
        }
        Trie.prove(trie, key, (e, prove) => {
          try {
            if (e) {
              return reject(e)
            }
            resolve(prove.map(o => o.toString('hex')))
          } catch (e) {
            reject(e)
          }
        })
      } catch (e) {
        reject(e)
      }
    })
  })
}

const getProof = async (redis, timestamp, key) => {
  const block = await getNextBlockInfo(redis, timestamp)
  if (!block) {
    return null
  }
  return {
    index: block.index,
    proof: await prove(
      new Trie(Levelup(Redisdown(block.location), {
          host: redis.options.host,
          port: redis.options.port
        }),
        Buffer.from(block.root, 'hex')
      ),
      block.root,
      Buffer.from(key, 'hex')
    )
  }
}

const getBlock = async (redis, id = null, records = false) => {
  let block = null
  if (id != null) {
    let blockLedgerStreamId
    if (id.toString().match(/^[a-z0-9]{64}$/)) {
      blockLedgerStreamId = await redis.get(util.format(blockLedgerIdByRootKeyFormat, id))
    } else {
      blockLedgerStreamId = await redis.get(util.format(blockLedgerIdByIndexKeyFormat, id))
    }
    if (!blockLedgerStreamId) {
      return null
    }
    block = await getBlockInfo(redis, blockLedgerStreamId)
  } else {
    const last = await getLastBlockInfo(redis)
    if (last) {
      block = {
        index: last.index + 1,
        previous: {
          root: last.root,
          timestamp: last.timestamp
        }
      }
    } else {
      block = {
        index: 0
      }
    }
  }
  if (records) {
    const previousTimestamp = block.index > 0 && (await getBlock(redis, block.index - 1)).timestamp
    block.records = (await redis.xrange(recordStream, previousTimestamp || '-', block.timestamp ? block.timestamp : '+')).map(o => o[1][1])
  }
  return blockResponse(block)
}

const createBlock = async (redis, empty, max) => {
  await cleanBlocks(redis)
  const end = await getLastTodoStreamId(redis)
  if (end === null && !empty) {
    return null
  }
  redis = getNewRedisClient(redis)
  try {
    await redis.watch(blockStream)
    const block = await getNewBlock(redis)
    end !== null && max !== 0 && await new Promise((resolve, reject) => {
      setTimeout(async function run() {
        try {
          const countArgs = max >= 0 ? ['COUNT', Math.min(max - block.count, 1000)] : []
          const results = await redis.xrange(recordStream, getNextStreamId(block.streamId), end, ...countArgs)
          for (const result of results) {
            const streamId = result[0]
            const object = objectify(result[1])
            await new Promise((resolve, reject) => {
              block.trie.put(Buffer.from(object.key, 'hex'), Buffer.from(object.value, 'hex'), e => {
                try {
                  if (e) {
                    return reject(e)
                  }
                  resolve()
                } catch (e) {
                  reject(e)
                }
              })
            })
            block.count++
            block.streamId = streamId
          }
          const lastBlock = await getLastBlockInfo(redis)
          if (lastBlock && lastBlock.index >= block.index) {
            reject(new ConcurrentError())
            return
          }
          const endReached = (end !== '+') && (end <= block.streamId)
          const maxReached = (max >= 0) && (max - block.count <= 0)
          if (endReached || maxReached) {
            resolve()
          } else {
            setTimeout(run, results.length > 0 ? 0 : 1000)
          }
        } catch (e) {
          reject(e)
        }
      }, 0)
    })
    if (block.count === 0 && !empty) {
      return null
    }
    let streamId = block.streamId
    let key = previousKey
    let value = block.previous
    if (block.count === 0) {
      streamId = getNextStreamId(block.streamId)
    }
    if (block.index === 0) {
      key = seedKey
      value = random(32)
    }
    await new Promise((resolve, reject) => {
      block.trie.put(key, Buffer.from(value, 'hex'), e => {
        try {
          if (e) {
            return reject(e)
          }
          resolve()
        } catch (e) {
          reject(e)
        }
      })
    })
    const root = block.trie.root.toString('hex')
    const result = {
      streamId,
      index: block.index,
      location: block.location,
      timestamp: block.timestamp,
      count: block.count,
      root: root,
      previous: block.index === 0 ? null : {
        root: block.previous,
        proof: await prove(block.trie, root, previousKey)
      }
    }
    await execOperations(redis, [
      ['xadd', blockStream, streamId, 'block', JSON.stringify(result)],
      ['set', util.format(blockLedgerIdByRootKeyFormat, root), streamId],
      ['set', util.format(blockLedgerIdByIndexKeyFormat, block.index), streamId],
      ['xdel', blockPendingStream, block.blockPendingStreamId]
    ])
    return blockResponse(result)
  } finally {
    redis.disconnect()
  }
}

module.exports = {
  getProof,
  getBlock,
  createBlock
}
