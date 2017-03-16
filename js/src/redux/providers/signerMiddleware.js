// Copyright 2015-2017 Parity Technologies (UK) Ltd.
// This file is part of Parity.

// Parity is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

// Parity is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.

// You should have received a copy of the GNU General Public License
// along with Parity.  If not, see <http://www.gnu.org/licenses/>.

import Transaction from 'ethereumjs-tx';

import * as actions from './signerActions';

import { inHex } from '~/api/format/input';
import HardwareStore from '~/mobx/hardwareStore';
import { Signer } from '~/util/signer';

export default class SignerMiddleware {
  constructor (api) {
    this._api = api;
    this._hwstore = HardwareStore.get(api);
  }

  toMiddleware () {
    return (store) => (next) => (action) => {
      let delegate;

      switch (action.type) {
        case 'signerStartConfirmRequest':
          delegate = this.onConfirmStart;
          break;

        case 'signerStartRejectRequest':
          delegate = this.onRejectStart;
          break;

        default:
          next(action);
          return;
      }

      if (!delegate) {
        return;
      }

      next(action);
      delegate(store, action);
    };
  }

  _createConfirmPromiseHandler (store, id) {
    return (promise) => {
      return promise
        .then((txHash) => {
          if (!txHash) {
            store.dispatch(actions.errorConfirmRequest({ id, err: 'Unable to confirm.' }));
            return;
          }

          store.dispatch(actions.successConfirmRequest({ id, txHash }));
        })
        .catch((error) => {
          console.error('confirmRequest', id, error);
          store.dispatch(actions.errorConfirmRequest({ id, err: error.message }));
        });
    };
  }

  createNoncePromise (transaction) {
    return !transaction.nonce || transaction.nonce.isZero()
      ? this._api.parity.nextNonce(transaction.from)
      : Promise.resolve(transaction.nonce);
  }

  confirmLedgerTransaction (store, id, transaction) {
    return this
      .createNoncePromise(transaction)
      .then((nonce) => {
        transaction.nonce = nonce;

        return this._hwstore.signLedger(transaction);
      })
      .then((rawTx) => {
        return this.confirmRawTransaction(store, id, rawTx);
      });
  }

  confirmRawTransaction (store, id, rawTx) {
    const handlePromise = this._createConfirmPromiseHandler(store, id);

    return handlePromise(this._api.signer.confirmRequestRaw(id, rawTx));
  }

  confirmSignedTransaction (store, id, transaction, txSigned) {
    const { chainId, signature, tx } = txSigned;
    const { data, gasPrice, gasLimit, nonce, to, value } = tx;

    const r = Buffer.from(signature.substr(2, 64), 'hex');
    const s = Buffer.from(signature.substr(66, 64), 'hex');
    const v = Buffer.from([parseInt(signature.substr(130, 2), 16) + (chainId * 2) + 35]);

    const signedTx = new Transaction({
      chainId,
      data,
      gasPrice,
      gasLimit,
      nonce,
      to,
      value,
      r,
      s,
      v
    });

    return this.confirmRawTransaction(store, id, signedTx.serialize().toString('hex'));
  }

  confirmWalletTransaction (store, id, transaction, wallet, password) {
    const { worker } = store.getState().worker;

    const signerPromise = worker && worker._worker.state === 'activated'
      ? worker
        .postMessage({
          action: 'getSignerSeed',
          data: { wallet, password }
        })
        .then((result) => {
          const seed = Buffer.from(result.data);

          return new Signer(seed);
        })
      : Signer.fromJson(wallet, password);

    // NOTE: Derving the key takes significant amount of time,
    // make sure to display some kind of "in-progress" state.
    return Promise
      .all([ signerPromise, this.createNoncePromise(transaction) ])
      .then(([ signer, nonce ]) => {
        const txData = {
          to: inHex(transaction.to),
          nonce: inHex(transaction.nonce.isZero() ? nonce : transaction.nonce),
          gasPrice: inHex(transaction.gasPrice),
          gasLimit: inHex(transaction.gas),
          value: inHex(transaction.value),
          data: inHex(transaction.data)
        };

        return signer.signTransaction(txData);
      })
      .then((rawTx) => {
        return this.confirmRawTransaction(store, id, rawTx);
      })
      .catch((error) => {
        console.error(error.message);
        store.dispatch(actions.errorConfirmRequest({ id, err: error.message }));
      });
  }

  onConfirmStart = (store, action) => {
    const { condition, gas = 0, gasPrice = 0, id, password, payload, txSigned, wallet } = action.payload;
    const handlePromise = this._createConfirmPromiseHandler(store, id);
    const transaction = payload.sendTransaction || payload.signTransaction;

    if (transaction) {
      const hardwareAccount = this._hwstore.wallets[transaction.from];

      if (wallet) {
        return this.confirmWalletTransaction(store, id, transaction, wallet, password);
      } else if (txSigned) {
        return this.confirmSignedTransaction(store, id, transaction, txSigned);
      } else if (hardwareAccount) {
        switch (hardwareAccount.via) {
          case 'ledger':
            return this.confirmLedgerTransaction(store, id, transaction);

          case 'parity':
          default:
            break;
        }
      }
    }

    return handlePromise(this._api.signer.confirmRequest(id, { gas, gasPrice, condition }, password));
  }

  onRejectStart = (store, action) => {
    const id = action.payload;

    return this._api.signer
      .rejectRequest(id)
      .then(() => {
        store.dispatch(actions.successRejectRequest({ id }));
      })
      .catch((error) => {
        console.error('rejectRequest', id, error);
        store.dispatch(actions.errorRejectRequest({ id, err: error.message }));
      });
  }
}
