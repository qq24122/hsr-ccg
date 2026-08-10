#!/usr/bin/perl
# 极简静态文件服务器：只依赖 Perl 核心模块（IO::Socket::INET）。
# 用途：浏览器自动化工具只支持 http(s)，不支持 file://，所以本地页面需要经由它提供。
# 用法: perl serve.pl [端口=8848] [根目录=脚本所在目录]
use strict;
use warnings;
use IO::Socket::INET;
use File::Basename qw(dirname);
use File::Spec;

my $port = shift // 8848;
my $root = shift // dirname( File::Spec->rel2abs(__FILE__) );
$root = File::Spec->rel2abs($root);

my %MIME = (
    html => 'text/html; charset=utf-8',
    js   => 'text/javascript; charset=utf-8',
    mjs  => 'text/javascript; charset=utf-8',
    css  => 'text/css; charset=utf-8',
    json => 'application/json; charset=utf-8',
    tsv  => 'text/plain; charset=utf-8',
    csv  => 'text/plain; charset=utf-8',
    txt  => 'text/plain; charset=utf-8',
    md   => 'text/plain; charset=utf-8',
    png  => 'image/png',
    jpg  => 'image/jpeg',
    jpeg => 'image/jpeg',
    webp => 'image/webp',
    gif  => 'image/gif',
    svg  => 'image/svg+xml',
    ico  => 'image/x-icon',
);

my $srv = IO::Socket::INET->new(
    LocalAddr => '127.0.0.1',
    LocalPort => $port,
    Listen    => 16,
    Reuse     => 1,
    Proto     => 'tcp',
) or die "无法监听 $port: $!\n";

$| = 1;
print "serving $root  ->  http://127.0.0.1:$port/\n";

while ( my $cli = $srv->accept ) {
    my $line = <$cli>;
    unless ( defined $line ) { close $cli; next }
    # 吃掉剩余请求头
    while ( my $h = <$cli> ) { last if $h =~ /^\r?\n$/ }

    my ( $method, $uri ) = $line =~ m{^(\w+)\s+(\S+)} ? ( $1, $2 ) : ( '', '' );
    $uri =~ s/\?.*$//;
    $uri = '/test/index.html' if $uri eq '/';
    $uri =~ s{%([0-9A-Fa-f]{2})}{chr hex $1}ge;

    # 防目录穿越
    my @parts = grep { length && $_ ne '.' && $_ ne '..' } split m{/}, $uri;
    my $path = File::Spec->catfile( $root, @parts );

    if ( $method ne 'GET' || !-f $path ) {
        my $body = "404 $uri";
        print $cli "HTTP/1.1 404 Not Found\r\nContent-Type: text/plain; charset=utf-8\r\n"
            . "Content-Length: " . length($body) . "\r\nConnection: close\r\n\r\n$body";
        close $cli;
        next;
    }

    my ($ext) = $path =~ /\.([A-Za-z0-9]+)$/;
    my $ct = $MIME{ lc( $ext // '' ) } // 'application/octet-stream';

    open my $fh, '<:raw', $path or do { close $cli; next };
    local $/;
    my $data = <$fh>;
    close $fh;

    print $cli "HTTP/1.1 200 OK\r\nContent-Type: $ct\r\n"
        . "Content-Length: " . length($data) . "\r\n"
        . "Cache-Control: no-store\r\nConnection: close\r\n\r\n";
    print $cli $data;
    close $cli;
    printf "  %s %s (%d B)\n", $method, $uri, length($data);
}
