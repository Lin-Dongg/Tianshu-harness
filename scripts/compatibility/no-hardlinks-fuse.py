#!/usr/bin/env python3
"""Test filesystem: passthrough with link(2) returning EPERM, like Android storage.

Usage: python3 no-hardlinks-fuse.py BACKING_DIRECTORY MOUNTPOINT
Requires fusepy and /dev/fuse. Use disposable directories, never production data.
"""
import errno
import os
import sys
try:
    from fuse import FUSE, FuseOSError, Operations
except ImportError:
    from fusepy import FUSE, FuseOSError, Operations


class NoHardlinks(Operations):
    def __init__(self, root):
        self.root = os.path.realpath(root)

    def path(self, path):
        return self.root + path

    def getattr(self, path, fh=None):
        st = os.lstat(self.path(path))
        return {key: getattr(st, key) for key in (
            'st_atime', 'st_ctime', 'st_gid', 'st_mode', 'st_mtime',
            'st_nlink', 'st_size', 'st_uid')}

    def readdir(self, path, fh):
        return ['.', '..'] + os.listdir(self.path(path))

    def mkdir(self, path, mode):
        os.mkdir(self.path(path), mode)

    def rmdir(self, path):
        os.rmdir(self.path(path))

    def unlink(self, path):
        os.unlink(self.path(path))

    def rename(self, old, new):
        os.rename(self.path(old), self.path(new))

    def link(self, target, source):
        raise FuseOSError(errno.EPERM)

    def chmod(self, path, mode):
        os.chmod(self.path(path), mode)

    def chown(self, path, uid, gid):
        os.chown(self.path(path), uid, gid)

    def utimens(self, path, times=None):
        os.utime(self.path(path), times)

    def open(self, path, flags):
        return os.open(self.path(path), flags)

    def create(self, path, mode, fi=None):
        return os.open(self.path(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)

    def read(self, path, size, offset, fh):
        return os.pread(fh, size, offset)

    def write(self, path, data, offset, fh):
        return os.pwrite(fh, data, offset)

    def truncate(self, path, length, fh=None):
        os.truncate(self.path(path), length)

    def flush(self, path, fh):
        os.fsync(fh)

    def fsync(self, path, datasync, fh):
        os.fsync(fh)

    def release(self, path, fh):
        os.close(fh)

    def statfs(self, path):
        st = os.statvfs(self.path(path))
        return {key: getattr(st, key) for key in (
            'f_bavail', 'f_bfree', 'f_blocks', 'f_bsize', 'f_favail',
            'f_ffree', 'f_files', 'f_frsize', 'f_namemax')}


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    FUSE(NoHardlinks(sys.argv[1]), sys.argv[2], foreground=True, nothreads=True)
