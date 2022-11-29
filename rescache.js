'use strict';
/*
 This class contains the map storing the cached multiple records, such 
 records includes the results of calling the functions indicated by
 'key', and the pending queue having the concurrent callers of the same 
 function there, so that we can use the result cached (via calling the 
 function once) to respond all of the callers, instead of calling multiple
 times. it's very helpful in case of very expensive cost in calling the 
 original function simultaneously, basically such function combines lot 
 more read operations, by using this cache it can reduce the callings of
 such function significantly.

 The structure for each cache record is like following:
 [key] => {
    timestamp,    // cache entry timestamp
    data: {}      // the result of calling the function.
    pending: []   // the pending queue
    idx:          // the position index in the FIFO queue
 }

 It also contains the FIFO queue storing the multiple keys, so we can
 evict the older records by traversing the queue, be aware that we evict
 such older records in lazy deletion style.
 */
class ResCache {
  constructor(options = {}) {
    const {
      // ttl value is being of the following types:
      //  0 no cache;
      // -1 evecting top N records peroidically;
      // +n evecting top N expired records peroidically;
      ttl = 0, 
      max_evicted = 2, 
      scan_itv = 60 * 1000, 
    } = options;

    this._cache = new Map();
    this._queue = [];
    this.ttl = ttl;
    this.max_evicted = max_evicted;
    this.scan_itv = scan_itv;

    this.last_evicted = 0;
  }

  async get(key, fetch_func) {
    // lazy shrink: evict the cache records if necessary.
    this._shrink();
    let rec = this._cache.get(key);

    if (rec === undefined) {
      // no result cached, calling the function
      return await this._get(key, fetch_func);
    } else if (rec.data === undefined && rec.pending !== undefined) {
      // the request is pending, just create new promise object and add it
      // to the pending queue, we can get the result later.
      let wait = new Promise((resolve, reject) => {
        rec.pending.push({
          resolve: resolve,
          reject: reject
        });
      });

      return await wait;
    } else if (this.ttl > 0 && rec.timestamp + this.ttl < Date.now()) {
      // we just evict top N (instead all of) expired records, so there're 
      // still remaining records expired, for such records we should set 
      // a special flag 'null' ('key' previously) for the queue entry, and
      // remove the record from cache, to prevent another fresh record
      // associated by 'key' being removed prematurely.
      this._queue[rec.idx] = null;
      this._cache.delete(key);
      return await this._get(key, fetch_func); 
    } else {
      // return cached data
      return rec.data;
    }
  }

  async _get(key, fetch_func) {
    // initialize the cache record
    let rec = { pending: [] };
    this._cache.set(key, rec);

    try {
      // calling the actual fetching function
      let result = await fetch_func();
      let qlen;

      // NOTE. once the result gets ready, we will notify the waiters (via 
      // traversing the pending queue) before returning the result to the 
      // original promise object, and such logic breaks the calling sequence
      // of such promises.
      rec.pending.
        forEach(waiter => waiter.resolve(result));

      if (this.ttl !== 0) {
        // cache the result if necessary
        qlen = this._queue.push(key);
        this._cache.set(key, 
          {
            timestamp: this.ttl && Date.now(), 
            data: result,
            idx: qlen - 1, 
          });
      } else {
        // no need to cache the result, clean the record
        this._cache.delete(key);
      }

      return result;
    } catch (err) {
      // in case of error we still notify the error to the waiters.
      if (rec) {
          rec.pending.
            forEach(waiter => waiter.reject(err));

          // delete the cache to give the chance to succeed later.
          this._cache.delete(key);
      }

      throw err;
    }
  }

  _shrink() {
    let now = Date.now();
    let evicted = 0;
    let scan = 0;
    let key, rec;

    if (this.ttl === 0) {
      // no need to cache the result, no one being evicted neither.
      return 0;
    }

    if (this.last_evicted + this.scan_itv > now) {
      // we don't evict the cache records in case of no timed out.
      return 0;
    }

    this.last_evicted = now;
    if (this.ttl === -1) {
      // no cache ttl set, we should evict top N cache records.
      while (evicted < this.max_evicted) {
        key = this._queue.shift();
        if (key === undefined)
          return evicted;

        this._cache.delete(key);
        evicted++;
      }

      return evicted;
    }

    while (evicted < this.max_evicted) {
      // evict top N expired records
      key = this._queue.shift();
      if (key === undefined)
        return evicted;
      else if (key === null) {
        // the expired cache record had been removed manually, it's NOT
        // released by this function.
        continue;
      }

      rec = this._cache.get(key);
      if (!rec) {
        // no record cached for the key, why?
        continue;
      } else if (rec.timestamp + this.ttl < now) {
        // this record has been expired, drop it.
        this._cache.delete(key);
        evicted++;
      } else {
        // this record is still available, get back into the queue.
        this._queue.unshift(key);
        return evicted;
      }
    }

    return evicted;
  }
}

module.exports = ResCache;
