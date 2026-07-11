# Benchmarking to measure performance

To compare the performance of the `uutils` version of `head` with the
GNU version of `head`, you can use a benchmarking tool like
[hyperfine][0]. On Ubuntu 18.04 or later, you can install `hyperfine` by
running

```shell
sudo apt-get install hyperfine
```

Next, build the `head` binary under the release profile:

```shell
cargo build --release -p uu_head
```

Now, get a text file to test `head` on. I used the *Complete Works of
William Shakespeare*, which is in the public domain in the United States
and most other parts of the world.

```shell
curl -o shakespeare.txt https://www.gutenberg.org/files/100/100-0.txt
```

This particular file has about 170,000 lines, each of which is no longer
than 96 characters:

```shell
$ wc -lL shakespeare.txt
170592      96 shakespeare.txt
```

You could use files of different shapes and sizes to test the
performance of `head` in different situations. For a larger file, you
could download a [database dump of Wikidata][1] or some related files
that the Wikimedia project provides. For example, [this file][2]
contains about 130 million lines.

Finally, you can compare the performance of the two versions of `head`
by running, for example,

```shell
hyperfine \
    "head -n 100000 shakespeare.txt" \
    "target/release/head -n 100000 shakespeare.txt"
```

[0]: https://github.com/sharkdp/hyperfine
[1]: https://www.wikidata.org/wiki/Wikidata:Database_download
[2]: https://dumps.wikimedia.org/wikidatawiki/20211001/wikidatawiki-20211001-pages-logging.xml.gz
