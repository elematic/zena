//! Implementation of garbage collection and GC types in Wasmtime.

mod arrayref;
mod exnref;
mod externref;
#[cfg(feature = "gc-drc")]
mod free_list;
mod structref;
#[cfg(any(feature = "gc-drc", feature = "gc-copying"))]
mod trace_infos;

pub use arrayref::*;
pub use exnref::*;
pub use externref::*;
pub use structref::*;

#[cfg(feature = "gc-drc")]
mod drc;
#[cfg(feature = "gc-drc")]
pub use drc::*;

#[cfg(feature = "gc-null")]
mod null;
#[cfg(feature = "gc-null")]
pub use null::*;

#[cfg(feature = "gc-copying")]
mod copying;
#[cfg(feature = "gc-copying")]
pub use copying::*;

/// A hasher that doesn't hash, for use in the trace-info hash map, where we are
/// just using scalar keys and aren't overly concerned with collision-based DoS.
#[derive(Default)]
pub struct NopHasher(u64);

impl core::hash::BuildHasher for NopHasher {
    type Hasher = Self;

    #[inline]
    fn build_hasher(&self) -> Self::Hasher {
        NopHasher::default()
    }
}

impl core::hash::Hasher for NopHasher {
    #[inline]
    fn finish(&self) -> u64 {
        // Zena patch: hashbrown takes the bucket from the hash's low bits
        // and the 7-bit tag from its top bits. A type index's top bits
        // are zero, so returning the key unmixed gave every entry the same
        // tag, and the subtype cache's `(sub << 32) | sup` keys started
        // probing at their supertype's bucket. Murmur3's 64-bit finalizer
        // spreads every key bit into both.
        let mut h = self.0;
        h ^= h >> 33;
        h = h.wrapping_mul(0xff51_afd7_ed55_8ccd);
        h ^= h >> 33;
        h = h.wrapping_mul(0xc4ce_b9fe_1a85_ec53);
        h ^= h >> 33;
        h
    }

    #[inline]
    fn write(&mut self, bytes: &[u8]) {
        let mut hash = self.0.to_ne_bytes();
        let n = hash.len().min(bytes.len());
        hash[..n].copy_from_slice(bytes);
        self.0 = u64::from_ne_bytes(hash);
    }

    #[inline]
    fn write_u8(&mut self, i: u8) {
        self.write_u64(i.into());
    }

    #[inline]
    fn write_u16(&mut self, i: u16) {
        self.write_u64(i.into())
    }

    #[inline]
    fn write_u32(&mut self, i: u32) {
        self.write_u64(i.into())
    }

    #[inline]
    fn write_u64(&mut self, i: u64) {
        self.0 = i;
    }

    #[inline]
    fn write_usize(&mut self, i: usize) {
        self.write_u64(i.try_into().unwrap());
    }
}
